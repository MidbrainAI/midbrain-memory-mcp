/**
 * ESLint rule for tests/: every child_process call passes an env built by a
 * sandbox helper (issue #94). A spawned hook or CLI child must never inherit
 * the worker's process.env: a credential or path override set after the
 * worker scrub, or one the scrub list misses, would reach the child.
 *
 * Accepted env values, checked on the AST rather than source text:
 *   - a call to sandboxedChildEnv(...), sandboxHomeEnv(...) or <x>.childEnv(...)
 *   - a call to a local function whose every return is one of those
 *   - an identifier declared with one of those
 *   - a parameter, when every call of the enclosing named function passes one
 */

const CHILD_PROCESS_FNS = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);
const MODULE_OBJECTS = new Set(["child_process", "childProcess", "cp"]);
const HELPERS = new Set(["sandboxedChildEnv", "sandboxHomeEnv"]);
const MESSAGE = "child process env must come from sandboxedChildEnv/sandboxHomeEnv/childEnv (tests/helpers), passed inline as the env option";

function memberName(node) {
  return node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier"
    ? node.property.name
    : null;
}

function isChildProcessCall(node) {
  const callee = node.callee;
  if (callee.type === "Identifier") return CHILD_PROCESS_FNS.has(callee.name);
  const name = memberName(callee);
  return name !== null && CHILD_PROCESS_FNS.has(name)
    && callee.object.type === "Identifier" && MODULE_OBJECTS.has(callee.object.name);
}

function findVariable(scope, name) {
  for (let current = scope; current; current = current.upper) {
    const variable = current.set.get(name);
    if (variable) return variable;
  }
  return null;
}

function functionName(node) {
  if (node.type === "FunctionDeclaration" && node.id) return node.id.name;
  const parent = node.parent;
  if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") return parent.id.name;
  return null;
}

export default {
  meta: {
    type: "problem",
    docs: { description: "spawned test children get their env from a sandbox helper" },
    schema: [],
  },
  create(context) {
    const { sourceCode } = context;
    const calls = [];
    const functions = [];
    const returns = [];

    function returnsOf(fn) {
      return returns.filter((node) => {
        for (let current = node.parent; current; current = current.parent) {
          if (current === fn) return true;
          if (current.type === "FunctionDeclaration" || current.type === "FunctionExpression"
            || current.type === "ArrowFunctionExpression") return false;
        }
        return false;
      });
    }

    // Memoised per node; a node still being evaluated (a cycle) counts as not
    // sandboxed, a node evaluated before keeps its result.
    function isSandboxed(node, scope, memo) {
      if (!node) return false;
      if (memo.has(node)) return memo.get(node);
      memo.set(node, false);
      const result = evaluate(node, scope, memo);
      memo.set(node, result);
      return result;
    }

    function evaluate(node, scope, seen) {
      if (node.type === "CallExpression") {
        const callee = node.callee;
        if (memberName(callee) === "childEnv") return true;
        if (callee.type !== "Identifier") return false;
        if (HELPERS.has(callee.name)) return true;
        const variable = findVariable(scope, callee.name);
        const fn = variable?.defs.find((def) => def.type === "FunctionName")?.node;
        if (!fn) return false;
        const body = fn.body.type === "BlockStatement" ? returnsOf(fn).map((r) => r.argument) : [fn.body];
        return body.length > 0 && body.every((value) => isSandboxed(value, sourceCode.getScope(fn.body), seen));
      }
      if (node.type !== "Identifier") return false;
      const variable = findVariable(scope, node.name);
      if (!variable || variable.defs.length === 0) return false;
      return variable.defs.every((def) => {
        if (def.type === "Variable") return isSandboxed(def.node.init, scope, seen);
        if (def.type !== "Parameter") return false;
        const fn = def.node;
        const name = functionName(fn);
        const index = fn.params.indexOf(def.name);
        if (!name || index === -1) return false;
        const sites = calls.filter((call) => call.callee.type === "Identifier" && call.callee.name === name);
        return sites.length > 0 && sites.every((call) =>
          isSandboxed(call.arguments[index], sourceCode.getScope(call), seen));
      });
    }

    return {
      CallExpression(node) { calls.push(node); },
      ":function"(node) { functions.push(node); },
      ReturnStatement(node) { returns.push(node); },
      "Program:exit"() {
        for (const call of calls) {
          if (!isChildProcessCall(call)) continue;
          const options = call.arguments.at(-1);
          const envProperty = options?.type === "ObjectExpression"
            ? options.properties.find((p) => p.type === "Property" && !p.computed
              && (p.key.type === "Identifier" ? p.key.name : p.key.value) === "env")
            : undefined;
          if (!envProperty || !isSandboxed(envProperty.value, sourceCode.getScope(call), new Map())) {
            context.report({ node: envProperty ?? call, message: MESSAGE });
          }
        }
      },
    };
  },
};
