declare module "tree-sitter-bash" {
  import type Parser from "tree-sitter";
  const language: Parser.Language;
  export = language;
}

declare module "tree-sitter-pwsh" {
  import type Parser from "tree-sitter";
  const language: Parser.Language;
  export = language;
}
