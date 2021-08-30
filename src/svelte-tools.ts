import * as vscode from "vscode";
import * as path from "path";
import * as svelte from "svelte/compiler";
import {
  scss,
  babel,
  coffeescript,
  less,
  sass,
  stylus,
  typescript,
} from "svelte-preprocess";
import { existsSync, readFileSync } from "fs";
import { locateNodeModules } from "./utils";
import { IResult } from "./ambient";
import ts from "typescript";
import JSON5 from "json5";
const globToRegExp = require("glob-to-regexp");

let svelteCode = "";

const preprocessorList = [
  scss({}),
  typescript({}),
  babel({}),
  coffeescript({}),
  less({}),
  sass({}),
  stylus({}),
];

let final: IResult;
export async function generate(
  code: string,
  filename: string,
  nodeModules?: string,
  removeImports = false,
  autoInsert = false,
  target = "body"
): Promise<IResult> {
  final = {
    js: {},
    css: "",
    err: [],
    sourceMap: {},
  };

  const result = await compile(
    code,
    filename,
    removeImports,
    autoInsert,
    target
  );

  if (result.err.length !== 0)
    return { js: {}, css: "", err: result.err, sourceMap: {} };

  final.sourceMap[""] = filename;
  final.js[""] = result.js;
  final.sourceMap[">svelte/internal"] = "svelte/internal";
  final.js[">svelte/internal"] = svelteCode;
  final.css += result.css || "";

  // Find Node modules
  nodeModules = locateNodeModules(filename);
  const uri = "";
  let error = await walk(
    result.js,
    filename,
    nodeModules,
    uri,
    transformModule
  );
  if (error && error.code === "MODULE_NOT_FOUND") {
    return {
      js: {},
      css: "",
      err: [
        {
          message: `module not found: ${error.value}`,
          start: {
            line: 0,
            column: 0,
          },
        },
      ],
      sourceMap: {},
    };
  }

  return final;
}

async function transformModule(
  content: string,
  name: string,
  modulePath: string,
  uri: string,
  isNodeModule: boolean
) {
  final.sourceMap[uri] = modulePath;
  if (modulePath.endsWith(".svelte")) {
    const result = await compile(content, modulePath, false, false);

    final.err = [...final.err, ...result.err];
    final.js[uri] = result.js;
    final.css += result.css || "";
    return result.js;
  } else if (modulePath.endsWith(".js") || modulePath.endsWith(".mjs")) {
    final.js[uri] = content;
    return content;
  } else if (modulePath.endsWith(".ts")) {
    const js = ts.transpileModule(content, {
      compilerOptions: { module: 6, target: 1, strict: false },
    });
    final.js[uri] = js.outputText;
  }
}

async function walk(
  content: string,
  filePath: string,
  nodeModule: string,
  uri: string,
  cb: (
    content: string,
    name: string,
    path: string,
    uri: string,
    isNodeModule: boolean
  ) => Promise<string | undefined>
): Promise<{
  code: string;
  value: string;
} | void> {
  const regex = /^\s*(?!\/)import.+?["|'](.+)["|']/gm;

  while (1) {
    let isNodeModule = false;
    let match = regex.exec(content);
    if (match === null) break;

    const depName = match?.[1];
    if (depName !== undefined) {
      // ==> RESOLVE ABSOLUTE PATH OF THE MODULE
      let depPath = "";
      if (depName.startsWith(".")) {
        depPath = path.resolve(path.dirname(filePath), depName);
        if (!depPath.match(/\.\w+$/)) {
          if (existsSync(depPath + ".js")) {
            depPath += ".js";
          } else if (existsSync(depPath + ".mjs")) {
            depPath += ".mjs";
          } else if (existsSync(depPath + ".ts")) {
            depPath += ".ts";
          } else {
            const packageJsonPath = path.resolve(depPath, "package.json");
            const packageJson = JSON.parse(
              readFileSync(packageJsonPath).toString()
            );
            depPath = path.resolve(depPath, packageJson.module);
          }
        }
      } else {
        const alias = check_aliases(depName, filePath);
        if (alias) {
          depPath = alias;
        } else {
          if (!depPath.match(/\.\w+$/)) {
            depPath = path.resolve(nodeModule, depName);
            isNodeModule = true;
          }
        }
        if (!depPath.includes(".")) {
          if (existsSync(depPath + ".js")) {
            depPath += ".js";
          } else if (existsSync(depPath + ".ts")) {
            depPath += ".ts";
          } else if (existsSync(path.resolve(depPath, "package.json"))) {
            const packageJsonPath = path.resolve(depPath, "package.json");
            const packageJson = JSON.parse(
              readFileSync(packageJsonPath).toString()
            );
            depPath = path.resolve(
              depPath,
              packageJson.module || packageJson.svelte
            );
          } else if (existsSync(depPath + ".mjs")) {
            depPath += ".mjs";
          } else if (existsSync(path.resolve(depPath, "index.js"))) {
            depPath = path.resolve(depPath, "index.js");
          } else if (existsSync(path.resolve(depPath, "index.ts"))) {
            depPath = path.resolve(depPath, "index.ts");
          } else {
            // TODO: not found error
          }
        }
      }
      const openDoc = vscode.workspace.textDocuments.find(
        (doc) => doc.fileName === depPath
      );
      let depContent;
      if (openDoc) {
        depContent = openDoc.getText();
      } else if (existsSync(depPath)) {
        depContent = readFileSync(depPath).toString();
      } else {
        return {
          code: "MODULE_NOT_FOUND",
          value: depName,
        };
      }
      depContent =
        (await cb(
          depContent,
          depName,
          depPath,
          uri + ">" + depName,
          isNodeModule
        )) || depContent;

      let error = await walk(
        depContent,
        depPath,
        nodeModule,
        uri + ">" + depName,
        cb
      );
      if (error) {
        return error;
      }
    }
  }
}

function check_aliases(alias: string, modulePath: string) {
  const nodeModules = locateNodeModules(modulePath);
  if (!nodeModules) return;

  const tsconfigPath = path.join(path.dirname(nodeModules), "tsconfig.json");
  if (!existsSync(tsconfigPath)) return;

  const tsconfig = JSON5.parse(readFileSync(tsconfigPath).toString());
  const aliases = (tsconfig?.compilerOptions?.paths || {}) as {
    [key: string]: string[];
  };
  let final = "";
  Object.entries(aliases).forEach(([pattern, paths]) => {
    if (alias.match(globToRegExp(pattern))) {
      const importPatern = pattern;
      paths.forEach((e) => {
        let resultPath = alias.replace(
          importPatern.replace("*", ""),
          e.replace("*", "")
        );
        resultPath = path.resolve(
          path.dirname(tsconfigPath),
          tsconfig.baseUrl || ".",
          resultPath
        );
        if (existsSync(resultPath)) {
          final = resultPath;
        } else if (existsSync(resultPath + ".js")) {
          final = resultPath + ".js";
        } else if (existsSync(resultPath + ".cjs")) {
          final = resultPath + ".cjs";
        } else if (existsSync(resultPath + ".ts")) {
          final = resultPath + ".ts";
        } else if (existsSync(resultPath + ".svelte")) {
          final = resultPath + ".svelte";
        }
      });
    }
  });
  return final;
}

export function loadSvelteCode(context: vscode.ExtensionContext) {
  const filepath = path.join(
    context?.extensionPath || "",
    "media",
    "svelte.js"
  );
  const file = readFileSync(filepath);
  svelteCode = file.toString();
}
async function compile(
  code: string,
  filename: string,
  removeImports = false,
  autoInsert = false,
  target = "body"
) {
  try {
    let preprocessed = await svelte.preprocess(code, preprocessorList, {
      filename,
    });
    if (!preprocessed) {
      return {
        js: "",
        css: "",
        err: [
          {
            start: {
              line: -1,
              column: -1,
            },
            message: "failed to preprocess",
          },
        ],
      };
    }

    let compiled = svelte.compile(preprocessed.toString?.() || "", {});
    let err = compiled.warnings;

    let js: string = compiled.js.code; // convert js imports to browser imports

    if (removeImports) {
      js = js.replace(/import[\w\W]+?";/, "");
    }

    if (autoInsert) {
      // convert component export to global variable
      js = js.replace(
        /\nexport default .+/,
        `
				new Component({
					target: document.querySelector("${target}")
				})
			`
      );
    }
    // get css from compilation
    let css: string = compiled.css.code;
    return { js, css, err };
  } catch (e) {
    return {
      js: "",
      css: "",
      err: [
        {
          start: {
            line: e.start?.line || e.line || 0,
            column: e.start?.column || e.column || 0,
          },
          message: e.message,
        },
      ],
    };
  }
}
