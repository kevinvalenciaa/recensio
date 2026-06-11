import { existsSync } from "node:fs";
import path from "node:path";
import Parser from "web-tree-sitter";

export type RefKind = "declaration" | "call" | "import" | "reference";

export interface SymbolRef {
  path: string;
  line: number;
  kind: RefKind;
  text: string;
}

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".java": "java",
};

export function langForFile(file: string, override?: string): string | undefined {
  if (override && Object.values(EXT_TO_LANG).includes(override)) return override;
  return EXT_TO_LANG[path.extname(file).toLowerCase()];
}

/** Grammar wasm lives in dist/grammars/ in the bundle, node_modules in dev. */
function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((c) => existsSync(c));
}

function coreWasmPath(): string | undefined {
  return firstExisting([
    path.join(__dirname, "grammars", "tree-sitter.wasm"),
    path.join(process.cwd(), "node_modules", "web-tree-sitter", "tree-sitter.wasm"),
  ]);
}

function grammarWasmPath(lang: string): string | undefined {
  return firstExisting([
    path.join(__dirname, "grammars", `tree-sitter-${lang}.wasm`),
    path.join(process.cwd(), "node_modules", "tree-sitter-wasms", "out", `tree-sitter-${lang}.wasm`),
  ]);
}

let initPromise: Promise<boolean> | undefined;
const languageCache = new Map<string, Parser.Language | null>();

async function ensureInit(): Promise<boolean> {
  if (initPromise === undefined) {
    initPromise = (async () => {
      const core = coreWasmPath();
      if (!core) return false;
      try {
        await Parser.init({ locateFile: () => core });
        return true;
      } catch {
        return false;
      }
    })();
  }
  return initPromise;
}

/** True when the core runtime is loadable (gate / fallback signal). */
export async function astAvailable(): Promise<boolean> {
  return ensureInit();
}

export async function loadLanguage(lang: string): Promise<Parser.Language | null> {
  if (languageCache.has(lang)) return languageCache.get(lang)!;
  const wasm = grammarWasmPath(lang);
  let language: Parser.Language | null = null;
  if (wasm) {
    try {
      language = await Parser.Language.load(wasm);
    } catch {
      language = null;
    }
  }
  languageCache.set(lang, language);
  return language;
}

const IDENTIFIER_TYPES = new Set([
  "identifier",
  "type_identifier",
  "field_identifier",
  "property_identifier",
  "shorthand_property_identifier",
]);

const CALL_PARENTS = new Set(["call_expression", "call", "method_invocation", "function_call"]);
const IMPORT_ANCESTORS = new Set([
  "import_statement",
  "import_declaration",
  "import_from_statement",
  "import_spec",
  "import_specifier",
  "import_clause",
  "named_imports",
]);
const DECL_PARENTS = new Set([
  "function_declaration",
  "function_definition",
  "method_definition",
  "method_declaration",
  "class_declaration",
  "class_definition",
  "variable_declarator",
  "type_alias_declaration",
  "interface_declaration",
  "field_definition",
]);

function classify(node: Parser.SyntaxNode): RefKind {
  const parent = node.parent;
  if (!parent) return "reference";
  if (DECL_PARENTS.has(parent.type) && parent.childForFieldName("name")?.id === node.id) return "declaration";
  if (CALL_PARENTS.has(parent.type)) return "call";
  if (parent.type === "member_expression" || parent.type === "selector_expression") {
    const gp = parent.parent;
    if (gp && CALL_PARENTS.has(gp.type)) return "call";
  }
  let a: Parser.SyntaxNode | null = parent;
  for (let i = 0; i < 5 && a; i++) {
    if (IMPORT_ANCESTORS.has(a.type)) return "import";
    a = a.parent;
  }
  return "reference";
}

/**
 * Classifies every identifier occurrence of `symbol` in one file's source.
 * tree-sitter only yields identifier nodes for real identifiers, so matches
 * inside strings and comments are excluded for free — the advantage over grep.
 */
export function classifyInSource(
  language: Parser.Language,
  source: string,
  symbol: string,
  relPath: string,
): SymbolRef[] {
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  const refs: SymbolRef[] = [];
  const lines = source.split("\n");
  const stack: Parser.SyntaxNode[] = [tree.rootNode];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (IDENTIFIER_TYPES.has(node.type) && node.text === symbol) {
      const line = node.startPosition.row + 1;
      refs.push({ path: relPath, line, kind: classify(node), text: (lines[line - 1] ?? "").trim().slice(0, 200) });
    }
    for (let i = node.childCount - 1; i >= 0; i--) {
      const c = node.child(i);
      if (c) stack.push(c);
    }
  }
  tree.delete();
  parser.delete();
  return refs;
}
