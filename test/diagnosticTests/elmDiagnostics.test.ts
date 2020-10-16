import {
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticTag,
  Range,
} from "vscode-languageserver";
import { URI } from "vscode-uri";
import { ElmDiagnostics } from "../../src/providers/diagnostics/elmDiagnostics";
import { diagnosticsEquals } from "../../src/providers/diagnostics/fileDiagnostics";
import { Utils } from "../../src/util/utils";
import { baseUri } from "../utils/mockElmWorkspace";
import { getSourceFiles } from "../utils/sourceParser";
import { SourceTreeParser } from "../utils/sourceTreeParser";

describe("ElmDiagnostics", () => {
  let elmDiagnostics: ElmDiagnostics;
  const treeParser = new SourceTreeParser();

  const debug = process.argv.find((arg) => arg === "--debug");

  async function testDiagnostics(
    source: string,
    code: string,
    expectedDiagnostics: Diagnostic[],
  ) {
    await treeParser.init();
    elmDiagnostics = new ElmDiagnostics();

    const workspace = treeParser.getWorkspace(getSourceFiles(source));
    const uri = URI.file(baseUri + "Main.elm").toString();
    const treeContainer = workspace.getForest().getByUri(uri);

    if (!treeContainer) {
      fail();
    }

    const diagnostics = elmDiagnostics
      .createDiagnostics(treeContainer.tree, uri, workspace)
      .filter((diagnostic) => diagnostic.code === code);

    const diagnosticsEqual = Utils.arrayEquals(
      diagnostics,
      expectedDiagnostics,
      diagnosticsEquals,
    );

    if (debug && !diagnosticsEqual) {
      console.log(
        `Expecting ${JSON.stringify(expectedDiagnostics)}, got ${JSON.stringify(
          diagnostics,
        )}`,
      );
    }

    expect(diagnosticsEqual).toBeTruthy();
  }

  describe("boolean case expressions", () => {
    const diagnosticWithRange = (range: Range): Diagnostic => {
      return {
        code: "boolean_case_expr",
        message: "Use an if expression instead of a case expression.",
        source: "Elm",
        severity: DiagnosticSeverity.Warning,
        range,
      };
    };

    it("boolean case true", async () => {
      const source = `
module Bar exposing (..)

foo x =
    case x of
        True ->
            x
        _ -> not x
			`;

      await testDiagnostics(source, "boolean_case_expr", [
        diagnosticWithRange({
          start: { line: 4, character: 4 },
          end: { line: 7, character: 18 },
        }),
      ]);
    });

    it("boolean case false", async () => {
      const source = `
module Bar exposing (..)

foo x =
    case x of
        False ->
            x
        _ -> not x
			`;

      await testDiagnostics(source, "boolean_case_expr", [
        diagnosticWithRange({
          start: { line: 4, character: 4 },
          end: { line: 7, character: 18 },
        }),
      ]);
    });

    it("no boolean case", async () => {
      const source = `
module Bar exposing (..)

foo x =
    case x of
        Some ->
            x
        Other -> not x
			`;

      await testDiagnostics(source, "boolean_case_expr", []);
    });
  });

  describe("unused top level", () => {
    const diagnosticWithRangeAndName = (
      range: Range,
      name: string,
    ): Diagnostic => {
      return {
        code: "unused_top_level",
        message: `Unused top level definition \`${name}\``,
        source: "Elm",
        severity: DiagnosticSeverity.Warning,
        range,
        tags: [DiagnosticTag.Unnecessary],
      };
    };

    it("unused function", async () => {
      const source = `
module Bar exposing (foo)

foo = some

baz = 2

some = 1
			`;

      await testDiagnostics(source, "unused_top_level", [
        diagnosticWithRangeAndName(
          {
            start: { line: 5, character: 0 },
            end: { line: 5, character: 3 },
          },
          "baz",
        ),
      ]);
    });

    it("used variable as record update", async () => {
      const source = `
module Bar exposing (..)

addUsedVariable x =
    { x | name = "John" }
			`;

      await testDiagnostics(source, "unused_top_level", []);
    });

    it("used variable in case expression", async () => {
      const source = `
module Bar exposing (..)

foo x =
    case x of
      Bar -> 1
			`;

      await testDiagnostics(source, "unused_top_level", []);
    });

    it("used variable in all declaration", async () => {
      const source = `
module Bar exposing (..)

x y =
  case y of
   ( b, _ ) ->
    let
        _ =
            Debug.log "Unknown" b
    in
        model ! []
			`;

      await testDiagnostics(source, "unused_top_level", []);
    });

    it("only used in self", async () => {
      const source = `
module Bar exposing (foo, Some(..)))

type Some = Thing

foo = 1

bar = bar + foo
			`;

      await testDiagnostics(source, "unused_top_level", [
        diagnosticWithRangeAndName(
          {
            start: { line: 7, character: 0 },
            end: { line: 7, character: 3 },
          },
          "bar",
        ),
      ]);
    });

    it("destructuring same name", async () => {
      const source = `
module Foo exposing (..)

error : Model -> Maybe Error
error { error } =
    error
			`;

      await testDiagnostics(source, "unused_top_level", []);
    });

    it("used imported variable in pattern match", async () => {
      const source = `
module Foo exposing (foo)

import Color exposing (Color(..))

foo c =
  case c of
    Blue -> 1
			`;

      await testDiagnostics(source, "unused_top_level", []);
    });

    it("used imported variable as opaque", async () => {
      const source = `
module Foo exposing (foo)

import Color exposing (Color(..))

foo (Blue c) =
  c
			`;

      await testDiagnostics(source, "unused_top_level", []);
    });

    it("used in destructuring let", async () => {
      const source = `
module Foo exposing (..)

import Some exposing (Bar(..))

x =
  let
    (Bar 1) = some
  in
    1
			`;

      await testDiagnostics(source, "unused_top_level", []);
    });

    it("used binary imported function as prefix", async () => {
      const source = `
module Foo exposing (..)

import List.Extra exposing ((!!))

getItemAtIndex : Int -> Maybe String
getItemAtIndex index =
    let
        someList =
            [ "a", "b", "c" ]
    in
    (!!) someList index
			`;

      await testDiagnostics(source, "unused_top_level", []);
    });
  });

  describe("unused import", () => {
    const diagnosticWithRangeAndName = (
      range: Range,
      name: string,
    ): Diagnostic => {
      return {
        code: "unused_import",
        message: `Unused import \`${name}\``,
        source: "Elm",
        severity: DiagnosticSeverity.Warning,
        range,
        tags: [DiagnosticTag.Unnecessary],
      };
    };

    it("used as qualified", async () => {
      const source = `
module Foo exposing (..)

import Bar

foo = Bar.add 1
			`;

      await testDiagnostics(source, "unused_import", []);
    });

    it("used as qualified in pattern", async () => {
      const source = `
module Main exposing (..)

import Bar

z a =
    case a of
        Bar.Z ->
            1
			`;

      await testDiagnostics(source, "unused_import", []);
    });

    it("used in type reference", async () => {
      const source = `
module Foo exposing (..)

import Bar

foo : Bar.Thing
foo = bar
			`;

      await testDiagnostics(source, "unused_import", []);
    });

    it("used in type alias", async () => {
      const source = `
module Foo exposing (..)

import Bar

type alias Thing = { name : Bar.Name }
			`;

      await testDiagnostics(source, "unused_import", []);
    });

    it("unused but has alias", async () => {
      const source = `
module Foo exposing (..)

import Bar as B

foo = 1
			`;

      await testDiagnostics(source, "unused_import", []);
    });

    it("unused but has exposing", async () => {
      const source = `
module Foo exposing (..)

import Bar exposing (baz)

foo = 1
			`;

      await testDiagnostics(source, "unused_import", []);
    });

    it("unused import", async () => {
      const source = `
module Foo exposing (..)

import Bar

foo = 1
			`;

      await testDiagnostics(source, "unused_import", [
        diagnosticWithRangeAndName(
          {
            start: { line: 3, character: 0 },
            end: { line: 3, character: 10 },
          },
          "Bar",
        ),
      ]);
    });
  });

  describe("unused import alias", () => {
    const diagnosticWithRangeAndName = (
      range: Range,
      name: string,
    ): Diagnostic => {
      return {
        code: "unused_alias",
        message: `Unused import alias \`${name}\``,
        source: "Elm",
        severity: DiagnosticSeverity.Warning,
        range,
        tags: [DiagnosticTag.Unnecessary],
      };
    };

    it("no usage for alias", async () => {
      const source = `
module Foo exposing (..)

import Bar as B

foo = (+) 1 2
			`;

      await testDiagnostics(source, "unused_alias", [
        diagnosticWithRangeAndName(
          {
            start: { line: 3, character: 11 },
            end: { line: 3, character: 15 },
          },
          "B",
        ),
      ]);
    });

    it("used as qualified", async () => {
      const source = `
module Foo exposing (..)

import Bar as B

foo = B.add 1
			`;

      await testDiagnostics(source, "unused_alias", []);
    });

    it("used as qualified in pattern", async () => {
      const source = `
module Main exposing (..)

import X as Y

z a =
    case a of
        Y.Z ->
            1
			`;

      await testDiagnostics(source, "unused_alias", []);
    });

    it("used in type reference", async () => {
      const source = `
module Foo exposing (..)

import Bar as B

foo : B.Thing
foo = bar
			`;

      await testDiagnostics(source, "unused_alias", []);
    });

    it("used in type alias", async () => {
      const source = `
module Foo exposing (..)

import Bar as B

foo = B.math.add 1
			`;

      await testDiagnostics(source, "unused_alias", []);
    });

    it("used as qualified with nested record access", async () => {
      const source = `
module Foo exposing (..)


import Bar as B

type alias Thing = { name : B.Name }
			`;

      await testDiagnostics(source, "unused_alias", []);
    });
  });

  describe("unused imported value or type", () => {
    const diagnosticWithRangeAndName = (
      range: Range,
      name: string,
      type: string,
    ): Diagnostic => {
      return {
        code: "unused_imported_value",
        message: `Unused imported ${type} \`${name}\``,
        source: "Elm",
        severity: DiagnosticSeverity.Warning,
        range,
        tags: [DiagnosticTag.Unnecessary],
      };
    };

    it("used variable as record update", async () => {
      const source = `
module Bar exposing (..)

addUsedVariable x =
    { x | name = "John" }
			`;

      await testDiagnostics(source, "unused_imported_value", []);
    });

    it("used variable in case expression", async () => {
      const source = `
module Bar exposing (..)

foo x =
    case x of
      Bar -> 1
		`;

      await testDiagnostics(source, "unused_imported_value", []);
    });

    it("used variable in all declaration", async () => {
      const source = `
module Bar exposing (..)

x y =
  case y of
   ( b, _ ) ->
    let
        _ =
            Debug.log "Unknown" b
    in
        model ! []
		`;

      await testDiagnostics(source, "unused_imported_value", []);
    });

    it("used value constructor", async () => {
      const source = `
module Bar exposing (foo)

type Some = Thing

foo = Thing
		`;

      await testDiagnostics(source, "unused_imported_value", []);
    });

    it("exposed value constructor", async () => {
      const source = `
module Bar exposing (foo, Some(..))

type Some = Thing

foo = 1
		`;

      await testDiagnostics(source, "unused_imported_value", []);
    });

    it("destructuring same name", async () => {
      const source = `
module Foo exposing (..)

error : Model -> Maybe Error
error { error } =
    error
		`;

      await testDiagnostics(source, "unused_imported_value", []);
    });

    it("unused imported variable", async () => {
      const source = `
module Foo exposing (foo)

import Html exposing (div)

foo = 1
		`;

      await testDiagnostics(source, "unused_imported_value", [
        diagnosticWithRangeAndName(
          {
            start: { line: 3, character: 22 },
            end: { line: 3, character: 25 },
          },
          "div",
          "value",
        ),
      ]);
    });

    it("used imported variable in pattern match", async () => {
      const source = `
module Foo exposing (foo)

import Color exposing (Color(..))

foo c =
  case c of
    Blue -> 1
		`;

      await testDiagnostics(source, "unused_imported_value", []);
    });

    it("used imported variable as opaque", async () => {
      const source = `
module Foo exposing (foo)

import Color exposing (Color(..))

foo (Blue c) =
  c
		`;

      await testDiagnostics(source, "unused_imported_value", []);
    });

    it("used in destructuring let", async () => {
      const source = `
module Foo exposing (..)

import Some exposing (Bar(..))

x =
  let
    (Bar 1) = some
  in
    1
		`;

      await testDiagnostics(source, "unused_imported_value", []);
    });

    it("unused imported type", async () => {
      const source = `
module Foo exposing (..)

import Some exposing (Thing, Other)

x : Int -> Other
x y =
  Some.other y
		`;

      await testDiagnostics(source, "unused_imported_value", [
        diagnosticWithRangeAndName(
          {
            start: { line: 3, character: 22 },
            end: { line: 3, character: 27 },
          },
          "Thing",
          "type",
        ),
      ]);
    });
  });

  describe("unused pattern variable", () => {
    const diagnosticWithRangeAndName = (
      range: Range,
      name: string,
    ): Diagnostic => {
      return {
        code: "unused_pattern",
        message: `Unused pattern variable \`${name}\``,
        source: "Elm",
        severity: DiagnosticSeverity.Warning,
        range,
        tags: [DiagnosticTag.Unnecessary],
      };
    };

    it("used variable as record update", async () => {
      const source = `
module Bar exposing (..)

addUsedVariable x =
    { x | name = "John" }
			`;

      await testDiagnostics(source, "unused_pattern", []);
    });

    it("used variable in case expression", async () => {
      const source = `
module Bar exposing (..)

foo x =
    case x of
      Bar -> 1
			`;

      await testDiagnostics(source, "unused_pattern", []);
    });

    it("used variable in all declaration", async () => {
      const source = `
module Bar exposing (..)

x y =
  case y of
   ( b, _ ) ->
    let
        _ =
            Debug.log "Unknown" b
    in
        model ! []
			`;

      await testDiagnostics(source, "unused_pattern", []);
    });

    it("used value constructor", async () => {
      const source = `
module Bar exposing (foo)

type Some = Thing

foo = Thing
			`;

      await testDiagnostics(source, "unused_pattern", []);
    });

    it("exposed value constructor", async () => {
      const source = `
module Bar exposing (foo, Some(..))

type Some = Thing

foo = 1
			`;

      await testDiagnostics(source, "unused_pattern", []);
    });

    it("destructuring same name", async () => {
      const source = `
module Foo exposing (..)

error : Model -> Maybe Error
error { error } =
    error
			`;

      await testDiagnostics(source, "unused_pattern", []);
    });

    it("used imported variable in pattern match", async () => {
      const source = `
module Foo exposing (foo)

import Color exposing (Color(..))

foo c =
  case c of
    Blue -> 1
			`;

      await testDiagnostics(source, "unused_pattern", []);
    });

    it("used imported variable as opaque", async () => {
      const source = `
module Foo exposing (foo)

import Color exposing (Color(..))

foo (Blue c) =
  c
			`;

      await testDiagnostics(source, "unused_pattern", []);
    });

    it("unused in case pattern", async () => {
      const source = `
module Foo exposing (foo)

foo x =
  case x of
    Just y ->
      1
			`;

      await testDiagnostics(source, "unused_pattern", [
        diagnosticWithRangeAndName(
          {
            start: { line: 5, character: 9 },
            end: { line: 5, character: 10 },
          },
          "y",
        ),
      ]);
    });

    it("unused in case pattern as single", async () => {
      const source = `
module Foo exposing (foo)

foo x =
  case x of
    y ->
      1
			`;

      await testDiagnostics(source, "unused_pattern", [
        diagnosticWithRangeAndName(
          {
            start: { line: 5, character: 4 },
            end: { line: 5, character: 5 },
          },
          "y",
        ),
      ]);
    });

    it("used in destructuring let", async () => {
      const source = `
module Foo exposing (foo)

import Some exposing (Bar(..))

x =
  let
    (Bar 1) = some
  in
    1
			`;

      await testDiagnostics(source, "unused_pattern", []);
    });
  });

  describe("drop cons of item and list", () => {
    const diagnosticWithRange = (range: Range): Diagnostic => {
      return {
        code: "drop_cons_of_item_and_list",
        message: `If you cons an item to a literal list, then you can just put the item into the list.`,
        source: "Elm",
        severity: DiagnosticSeverity.Warning,
        range,
      };
    };

    it("no optimization", async () => {
      const source = `
module Bar exposing (foo)

foo : Int
foo =
    [1, 2] ++ var
			`;

      await testDiagnostics(source, "drop_cons_of_item_and_list", []);
    });

    it("cons with literal list", async () => {
      const source = `
module Bar exposing (foo)

foo : Int
foo =
    1 :: [2 , 3]
			`;

      await testDiagnostics(source, "drop_cons_of_item_and_list", [
        diagnosticWithRange({
          start: { line: 5, character: 4 },
          end: { line: 5, character: 16 },
        }),
      ]);
    });
  });

  describe("map nothing to nothing", () => {
    const diagnosticWithRange = (range: Range): Diagnostic => {
      return {
        code: "map_nothing_to_nothing",
        message: `\`Nothing\` mapped to \`Nothing\` in case expression. Use Maybe.map or Maybe.andThen instead.`,
        source: "Elm",
        severity: DiagnosticSeverity.Warning,
        range,
      };
    };

    it("map nothing to nothing", async () => {
      const source = `
module Foo exposing (..)

y = case x of
    Just a -> Just (a + 1)
    Nothing -> Nothing
			`;

      await testDiagnostics(source, "map_nothing_to_nothing", [
        diagnosticWithRange({
          start: { line: 5, character: 4 },
          end: { line: 5, character: 22 },
        }),
      ]);
    });

    it("map nothing to something", async () => {
      const source = `
module Foo exposing (..)

y = case x of
    Just a -> Just (a + 1)
    Nothing -> 0
			`;

      await testDiagnostics(source, "map_nothing_to_nothing", []);
    });

    it("map something to nothing", async () => {
      const source = `
module Foo exposing (..)

y = case x of
    Just a -> Nothing
    Nothing -> 0
			`;

      await testDiagnostics(source, "map_nothing_to_nothing", []);
    });
  });

  describe("drop concat of lists", () => {
    const diagnosticWithRange = (range: Range): Diagnostic => {
      return {
        code: "drop_concat_of_lists",
        message: `If you concatenate two lists, then you can merge them into one list.`,
        source: "Elm",
        severity: DiagnosticSeverity.Warning,
        range,
      };
    };

    it("could use cons", async () => {
      const source = `
module Bar exposing (foo)

foo : Int
foo =
    [1] ++ [3, 4]
			`;

      await testDiagnostics(source, "drop_concat_of_lists", [
        diagnosticWithRange({
          start: { line: 5, character: 4 },
          end: { line: 5, character: 17 },
        }),
      ]);
    });

    it("no optimization", async () => {
      const source = `
module Bar exposing (foo)

foo : Int
foo =
    [1, 2] ++ var
			`;

      await testDiagnostics(source, "drop_concat_of_lists", []);
    });

    it("concat multi element list", async () => {
      const source = `
module Bar exposing (foo)

foo : Int
foo =
    [1, 2] ++ [3, 4]
			`;

      await testDiagnostics(source, "drop_concat_of_lists", [
        diagnosticWithRange({
          start: { line: 5, character: 4 },
          end: { line: 5, character: 20 },
        }),
      ]);
    });
  });

  describe("use cons over concat", () => {
    const diagnosticWithRange = (range: Range): Diagnostic => {
      return {
        code: "use_cons_over_concat",
        message: `If you concatenate two lists, but the first item is a single element list, then you should use the cons operator.`,
        source: "Elm",
        severity: DiagnosticSeverity.Warning,
        range,
      };
    };

    it("no optimization", async () => {
      const source = `
module Bar exposing (foo)

foo : Int
foo =
    [1, 2] ++ bar
			`;

      await testDiagnostics(source, "use_cons_over_concat", []);
    });

    it("concat single item to var", async () => {
      const source = `
module Bar exposing (foo)

foo : Int
foo =
    [1] ++ bar
			`;

      await testDiagnostics(source, "use_cons_over_concat", [
        diagnosticWithRange({
          start: { line: 5, character: 4 },
          end: { line: 5, character: 14 },
        }),
      ]);
    });
  });

  describe("single field record", () => {
    const diagnosticWithRange = (range: Range): Diagnostic => {
      return {
        code: "single_field_record",
        message: `Using a record is obsolete if you only plan to store a single field in it.`,
        source: "Elm",
        severity: DiagnosticSeverity.Warning,
        range,
      };
    };

    it("single field", async () => {
      const source = `
module Bar exposing (foo)

type alias Foo =
  { x : Int }
			`;

      await testDiagnostics(source, "single_field_record", [
        diagnosticWithRange({
          start: { line: 4, character: 2 },
          end: { line: 4, character: 13 },
        }),
      ]);
    });

    it("single field generic", async () => {
      const source = `
module Bar exposing (foo)

type alias Foo =
  { a | x : Int }
			`;

      await testDiagnostics(source, "single_field_record", []);
    });

    it("multi field", async () => {
      const source = `
module Bar exposing (foo)

type alias Foo =
  { x : Int
  , y : String
  }
			`;

      await testDiagnostics(source, "single_field_record", []);
    });

    it("single field nested", async () => {
      const source = `
module Bar exposing (foo)

type alias Foo =
  { x : Int
  , y : { z : String }
  }
			`;

      await testDiagnostics(source, "single_field_record", [
        diagnosticWithRange({
          start: { line: 5, character: 8 },
          end: { line: 5, character: 22 },
        }),
      ]);
    });

    it("single field in type", async () => {
      const source = `
module Bar exposing (foo)

type Foo =
  Bar { x : Int }
			`;

      await testDiagnostics(source, "single_field_record", [
        diagnosticWithRange({
          start: { line: 4, character: 6 },
          end: { line: 4, character: 17 },
        }),
      ]);
    });

    xit("single field as generic arg", async () => {
      const source = `
module Bar exposing (foo)

type alias Params x a =
    { x
        | id : String
        , label : String
        , action : a
    }
-- more type aliasses that extends from Params
type alias CheckboxParams a =
    Params { checked : Bool } (Bool -> a)
			`;

      await testDiagnostics(source, "single_field_record", []);
    });
  });

  describe("unnecessary list concat", () => {
    const diagnosticWithRange = (range: Range): Diagnostic => {
      return {
        code: "unnecessary_list_concat",
        message: `You should just merge the arguments of \`List.concat\` to a single list.`,
        source: "Elm",
        severity: DiagnosticSeverity.Warning,
        range,
      };
    };

    it("could merge", async () => {
      const source = `
module Bar exposing (foo)

foo =
    List.concat [ [1], [2] ]
			`;

      await testDiagnostics(source, "unnecessary_list_concat", [
        diagnosticWithRange({
          start: { line: 4, character: 4 },
          end: { line: 4, character: 28 },
        }),
      ]);
    });

    it("could merge 2", async () => {
      const source = `
module Bar exposing (foo)

foo x =
  case x of
    DropConsOfItemAndList fileName range ->
        ( String.concat
            [ "Adding an item to the front of a literal list, but instead you can just put it in the list. "
            , fileName
            , " at "
            , rangeToString range
            ]
        , always (List.concat [ [ fileName ], [] ])
        , [ range ]
        , True
        )
			`;

      await testDiagnostics(source, "unnecessary_list_concat", [
        diagnosticWithRange({
          start: { line: 12, character: 18 },
          end: { line: 12, character: 50 },
        }),
      ]);
    });

    it("could not merge", async () => {
      const source = `
module Bar exposing (foo)

foo =
    List.concat [ bar, [2] ]
			`;

      await testDiagnostics(source, "unnecessary_list_concat", []);
    });
  });

  describe("unnecessary port module", () => {
    const diagnosticWithRange = (range: Range): Diagnostic => {
      return {
        code: "unnecessary_port_module",
        message: `Module is definined as a \`port\` module, but does not define any ports.`,
        source: "Elm",
        severity: DiagnosticSeverity.Warning,
        range,
      };
    };

    it("no ports", async () => {
      const source = `
port module Bar exposing (foo)

foo = 1

bar = 2

type alias Foo = {}

type Bar = Other
			`;

      await testDiagnostics(source, "unnecessary_port_module", [
        diagnosticWithRange({
          start: { line: 1, character: 0 },
          end: { line: 1, character: 30 },
        }),
      ]);
    });

    it("some ports", async () => {
      const source = `
port module Bar exposing (foo)

bar = 2

type alias Foo = {}

type Bar = Other

port foo : String -> Cmd msg
			`;

      await testDiagnostics(source, "unnecessary_port_module", []);
    });
  });

  describe("fully applied operator as prefix", () => {
    const diagnosticWithRange = (range: Range): Diagnostic => {
      return {
        code: "no_uncurried_prefix",
        message: `Don't use fully applied prefix notation for operators.`,
        source: "Elm",
        severity: DiagnosticSeverity.Warning,
        range,
      };
    };

    it("prefix as application with two args", async () => {
      const source = `
module Foo exposing (..)

foo = (+) 1 2
			`;

      await testDiagnostics(source, "no_uncurried_prefix", [
        diagnosticWithRange({
          start: { line: 3, character: 6 },
          end: { line: 3, character: 13 },
        }),
      ]);
    });

    it("prefix as application with one arg", async () => {
      const source = `
module Foo exposing (..)

foo = (+) 1
			`;

      await testDiagnostics(source, "no_uncurried_prefix", []);
    });
  });

  describe("unused type alias", () => {
    const diagnosticWithRangeAndName = (
      range: Range,
      name: string,
    ): Diagnostic => {
      return {
        code: "unused_type_alias",
        message: `Type alias \`${name}\` is not used.`,
        source: "Elm",
        severity: DiagnosticSeverity.Warning,
        range,
        tags: [DiagnosticTag.Unnecessary],
      };
    };

    it("unused but exposed", async () => {
      const source = `
module Foo exposing (Bar)

type alias Bar = Int
			`;

      await testDiagnostics(source, "unused_type_alias", []);
    });

    it("used in signature", async () => {
      const source = `
module Foo exposing (foo)

type alias Bar = Int

foo : Bar
foo = 1
			`;

      await testDiagnostics(source, "unused_type_alias", []);
    });

    it("used as function", async () => {
      const source = `
module Foo exposing (foo)

type alias Person = { name : String, age : Int}

foo =
    Person "John" 12
			`;

      await testDiagnostics(source, "unused_type_alias", []);
    });

    it("used in port", async () => {
      const source = `
module Foo exposing (foo)

type alias Person = { name : String, age : Int}

port foo : Person -> Cmd msg
			`;

      await testDiagnostics(source, "unused_type_alias", []);
    });

    it("used alias in record", async () => {
      const source = `
module Foo exposing (InputInterfaces)

type alias InputFiles =
    List String

type alias InputInterfaces =
    List ( String, InputFiles )
			`;

      await testDiagnostics(source, "unused_type_alias", []);
    });

    it("used alias in type", async () => {
      const source = `
module Foo exposing (Patch(..))

type alias InputFiles =
    List String

type Patch
    = OnFiles InputFiles
			`;

      await testDiagnostics(source, "unused_type_alias", []);
    });

    it("unused type alias", async () => {
      const source = `
module Foo exposing (foo)

type alias Person = { name : String, age : Int}

foo = 1
			`;

      await testDiagnostics(source, "unused_type_alias", [
        diagnosticWithRangeAndName(
          {
            start: { line: 3, character: 0 },
            end: { line: 3, character: 47 },
          },
          "Person",
        ),
      ]);
    });
  });

  describe("unused value constructor", () => {
    const diagnosticWithRangeAndName = (
      range: Range,
      name: string,
    ): Diagnostic => {
      return {
        code: "unused_value_constructor",
        message: `Value constructor \`${name}\` is not used.`,
        source: "Elm",
        severity: DiagnosticSeverity.Warning,
        range,
        tags: [DiagnosticTag.Unnecessary],
      };
    };

    it("unused but exposed", async () => {
      const source = `
module Foo exposing (Foo(..))

type Foo = Bar
			`;

      await testDiagnostics(source, "unused_value_constructor", []);
    });

    it("used and not exposed", async () => {
      const source = `
module Foo exposing (foo)

type Foo = Bar Int

foo = Bar 1
			`;

      await testDiagnostics(source, "unused_value_constructor", []);
    });

    it("unused and not exposed", async () => {
      const source = `
module Foo exposing (foo)

type Foo = Bar Int

foo (Bar i) = i
			`;

      await testDiagnostics(source, "unused_value_constructor", [
        diagnosticWithRangeAndName(
          {
            start: { line: 3, character: 11 },
            end: { line: 3, character: 18 },
          },
          "Bar",
        ),
      ]);
    });

    it("used value constructor", async () => {
      const source = `
module Bar exposing (foo)

type Some = Thing

foo = Thing
			`;

      await testDiagnostics(source, "unused_value_constructor", []);
    });

    it("unused value constructor not exposed", async () => {
      const source = `
module Bar exposing (foo, Some))

type Some = Thing | Other
			`;

      await testDiagnostics(source, "unused_value_constructor", [
        diagnosticWithRangeAndName(
          {
            start: { line: 3, character: 12 },
            end: { line: 3, character: 17 },
          },
          "Thing",
        ),
        diagnosticWithRangeAndName(
          {
            start: { line: 3, character: 20 },
            end: { line: 3, character: 25 },
          },
          "Other",
        ),
      ]);
    });

    it("exposed value constructor", async () => {
      const source = `
module Bar exposing (foo, Some(..)))

type Some = Thing

foo = 1
			`;

      await testDiagnostics(source, "unused_value_constructor", []);
    });
  });
});
