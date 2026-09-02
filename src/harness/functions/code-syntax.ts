import { parse } from "acorn";

interface SyntaxNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const positionalArguments = {
  search: "query",
  describe: "id",
  batch: "calls",
} as const;

/**
 * Convert Flary's public positional catalog calls to the object arguments
 * required by Cloudflare Codemode connectors.
 *
 * The conversion runs only for the trusted `tools` namespace. Invalid code
 * stays unchanged so the isolated runtime can return its normal syntax error.
 */
export function normalizeFlaryCatalogCalls(code: string): string {
  let program: SyntaxNode;
  try {
    program = parse(code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
    }) as unknown as SyntaxNode;
  } catch {
    return code;
  }

  const edits: TextEdit[] = [];
  visit(program, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = asNode(node.callee);
    if (!callee || callee.type !== "MemberExpression" || callee.computed === true) return;
    const object = asNode(callee.object);
    const property = asNode(callee.property);
    if (object?.type !== "Identifier" || object.name !== "tools") return;
    if (property?.type !== "Identifier" || typeof property.name !== "string") return;

    const args = Array.isArray(node.arguments)
      ? node.arguments.map(asNode).filter((value): value is SyntaxNode => Boolean(value))
      : [];
    const method = property.name;

    if (method in positionalArguments) {
      if (args.length !== 1) return;
      const key = positionalArguments[method as keyof typeof positionalArguments];
      if (hasObjectProperty(args[0]!, key)) return;
      edits.push(
        { start: args[0]!.start, end: args[0]!.start, text: `{ ${key}: ` },
        { start: args[0]!.end, end: args[0]!.end, text: " }" },
      );
      return;
    }

    if (method !== "call" || args.length !== 2) return;
    edits.push(
      { start: args[0]!.start, end: args[0]!.start, text: "{ id: " },
      { start: args[0]!.end, end: args[1]!.start, text: ", input: " },
      { start: args[1]!.end, end: args[1]!.end, text: " }" },
    );
  });

  return applyEdits(code, edits);
}

function asNode(value: unknown): SyntaxNode | undefined {
  if (!value || typeof value !== "object") return undefined;
  const node = value as Partial<SyntaxNode>;
  return typeof node.type === "string" &&
    typeof node.start === "number" &&
    typeof node.end === "number"
    ? (node as SyntaxNode)
    : undefined;
}

function visit(node: SyntaxNode, callback: (node: SyntaxNode) => void): void {
  callback(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        const child = asNode(item);
        if (child) visit(child, callback);
      }
      continue;
    }
    const child = asNode(value);
    if (child) visit(child, callback);
  }
}

function hasObjectProperty(node: SyntaxNode, name: string): boolean {
  if (node.type !== "ObjectExpression" || !Array.isArray(node.properties)) return false;
  return node.properties.some((value) => {
    const property = asNode(value);
    if (!property || property.type !== "Property" || property.computed === true) return false;
    const key = asNode(property.key);
    return (
      (key?.type === "Identifier" && key.name === name) ||
      (key?.type === "Literal" && key.value === name)
    );
  });
}

function applyEdits(code: string, edits: readonly TextEdit[]): string {
  return [...edits]
    .sort((left, right) => right.start - left.start || right.end - left.end)
    .reduce(
      (value, edit) => `${value.slice(0, edit.start)}${edit.text}${value.slice(edit.end)}`,
      code,
    );
}
