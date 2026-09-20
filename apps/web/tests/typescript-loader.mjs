// Use the app's TypeScript compiler, without adding a second test transpiler.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export function resolve(specifier, context, next) {
    if (specifier === 'server-only') return { url: 'data:text/javascript,export {};', shortCircuit: true };
    let url;
    if (specifier.startsWith('@/')) url = new URL(`../src/${specifier.slice(2)}`, import.meta.url);
    else if (specifier.startsWith('.') && context.parentURL) url = new URL(specifier, context.parentURL);
    if (url?.protocol === 'file:') {
      for (const suffix of ['', '.ts', '.tsx']) {
        if (existsSync(fileURLToPath(url) + suffix)) return next(url.href + suffix, context);
      }
    }
    return next(specifier, context);
}

export function load(url, context, next) {
    if (/\.tsx?$/.test(url) && !url.includes('/node_modules/')) {
      return {
        format: 'module', shortCircuit: true,
        source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
        }).outputText,
      };
    }
    return next(url, context);
}
