import { IClientSettings, Settings } from "src/util/settings";
import { debounce } from "ts-debounce";
import { container, injectable } from "tsyringe";
import { Diagnostic, FileChangeType, IConnection } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { ElmAnalyseDiagnostics } from "..";
import { IElmWorkspace } from "../../elmWorkspace";
import { ElmWorkspaceMatcher } from "../../util/elmWorkspaceMatcher";
import { NoWorkspaceContainsError } from "../../util/noWorkspaceContainsError";
import { ElmAnalyseTrigger } from "../../util/settings";
import { TextDocumentEvents } from "../../util/textDocumentEvents";
import { ASTProvider } from "../astProvider";
import { ElmLsDiagnostics } from "./elmLsDiagnostics";
import { ElmMakeDiagnostics } from "./elmMakeDiagnostics";
import { DiagnosticKind, FileDiagnostics } from "./fileDiagnostics";
import { TypeInferenceDiagnostics } from "./typeInferenceDiagnostics";

export interface IElmIssueRegion {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

export interface IElmIssue {
  tag: string;
  overview: string;
  subregion: string;
  details: string;
  region: IElmIssueRegion;
  type: string;
  file: string;
}

@injectable()
export class DiagnosticsProvider {
  private elmMakeDiagnostics: ElmMakeDiagnostics;
  private elmAnalyseDiagnostics: ElmAnalyseDiagnostics | null = null;
  private typeInferenceDiagnostics: TypeInferenceDiagnostics;
  private elmDiagnostics: ElmLsDiagnostics;
  private elmWorkspaceMatcher: ElmWorkspaceMatcher<{ uri: string }>;
  private currentDiagnostics: Map<string, FileDiagnostics>;
  private events: TextDocumentEvents;
  private connection: IConnection;
  private settings: Settings;
  private clientSettings: IClientSettings;
  private workspaces: IElmWorkspace[];

  constructor() {
    this.settings = container.resolve("Settings");
    this.clientSettings = container.resolve("ClientSettings");
    if (this.clientSettings.elmAnalyseTrigger !== "never") {
      this.elmAnalyseDiagnostics = container.resolve<ElmAnalyseDiagnostics | null>(
        ElmAnalyseDiagnostics,
      );
    }
    this.elmMakeDiagnostics = container.resolve<ElmMakeDiagnostics>(
      ElmMakeDiagnostics,
    );
    this.typeInferenceDiagnostics = container.resolve<TypeInferenceDiagnostics>(
      TypeInferenceDiagnostics,
    );
    this.elmDiagnostics = container.resolve<ElmLsDiagnostics>(ElmLsDiagnostics);
    this.connection = container.resolve<IConnection>("Connection");
    this.events = container.resolve<TextDocumentEvents>(TextDocumentEvents);
    this.elmWorkspaceMatcher = new ElmWorkspaceMatcher((doc) =>
      URI.parse(doc.uri),
    );
    this.workspaces = container.resolve("ElmWorkspaces");

    const astProvider = container.resolve<ASTProvider>(ASTProvider);

    this.currentDiagnostics = new Map<string, FileDiagnostics>();
    // register onChange listener if settings are not on-save only

    const elmAnalyseTrigger = this.clientSettings.elmAnalyseTrigger;
    this.events.on(
      "open",
      (d) => void this.getDiagnostics(d, true, elmAnalyseTrigger),
    );
    this.events.on(
      "save",
      (d) => void this.getDiagnostics(d, true, elmAnalyseTrigger),
    );
    this.connection.onDidChangeWatchedFiles((event) => {
      const newDeleteEvents = event.changes
        .filter((a) => a.type === FileChangeType.Deleted)
        .map((a) => a.uri);
      newDeleteEvents.forEach((uri) => {
        this.deleteDiagnostics(uri);
      });
    });
    if (this.elmAnalyseDiagnostics) {
      this.elmAnalyseDiagnostics.on(
        "new-diagnostics",
        this.newElmAnalyseDiagnostics.bind(this),
      );
    }
    if (elmAnalyseTrigger === "change") {
      this.events.on(
        "change",
        (d) => void this.getDiagnostics(d, false, elmAnalyseTrigger),
      );
    }

    this.connection.onDidChangeConfiguration((params) => {
      this.clientSettings = <IClientSettings>params.settings;

      if (this.clientSettings.disableElmLSDiagnostics) {
        this.currentDiagnostics.forEach((_, uri) =>
          this.updateDiagnostics(uri, DiagnosticKind.ElmLS, []),
        );
      } else {
        this.workspaces.forEach((workspace) => {
          workspace.getForest().treeMap.forEach((treeContainer) => {
            if (treeContainer.writeable) {
              this.updateDiagnostics(
                treeContainer.uri,
                DiagnosticKind.ElmLS,
                this.elmDiagnostics.createDiagnostics(
                  treeContainer.tree,
                  treeContainer.uri,
                  workspace,
                ),
              );
            }
          });
        });
      }
    });

    this.workspaces.forEach((workspace) => {
      workspace.getForest().treeMap.forEach((treeContainer) => {
        if (treeContainer.writeable) {
          const treeDiagnostics = this.typeInferenceDiagnostics.createDiagnostics(
            treeContainer,
            workspace,
          );

          this.updateDiagnostics(
            treeContainer.uri,
            DiagnosticKind.TypeInference,
            treeDiagnostics,
          );

          if (!this.clientSettings.disableElmLSDiagnostics) {
            this.updateDiagnostics(
              treeContainer.uri,
              DiagnosticKind.ElmLS,
              this.elmDiagnostics.createDiagnostics(
                treeContainer.tree,
                treeContainer.uri,
                workspace,
              ),
            );
          }
        }
      });

      astProvider.onTreeChange(({ treeContainer }) => {
        let workspace;
        try {
          workspace = this.elmWorkspaceMatcher.getElmWorkspaceFor({
            uri: treeContainer.uri,
          });
        } catch (error) {
          if (error instanceof NoWorkspaceContainsError) {
            this.connection.console.info(error.message);
            return; // ignore file that doesn't correspond to a workspace
          }

          throw error;
        }

        this.updateDiagnostics(
          treeContainer.uri,
          DiagnosticKind.TypeInference,
          this.typeInferenceDiagnostics.createDiagnostics(
            treeContainer,
            workspace,
          ),
        );

        if (!this.clientSettings.disableElmLSDiagnostics) {
          this.updateDiagnostics(
            treeContainer.uri,
            DiagnosticKind.ElmLS,
            this.elmDiagnostics.createDiagnostics(
              treeContainer.tree,
              treeContainer.uri,
              workspace,
            ),
          );
        }
      });
    });
  }

  private newElmAnalyseDiagnostics(
    diagnostics: Map<string, Diagnostic[]>,
  ): void {
    this.resetDiagnostics(diagnostics, DiagnosticKind.ElmAnalyse);

    diagnostics.forEach((diagnostics, uri) => {
      this.updateDiagnostics(uri, DiagnosticKind.ElmAnalyse, diagnostics);
    });
  }

  private updateDiagnostics(
    uri: string,
    kind: DiagnosticKind,
    diagnostics: Diagnostic[],
  ): void {
    let didUpdate = false;

    let fileDiagnostics = this.currentDiagnostics.get(uri);

    if (fileDiagnostics) {
      didUpdate = fileDiagnostics.update(kind, diagnostics);
    } else if (diagnostics.length > 0) {
      fileDiagnostics = new FileDiagnostics(uri);
      fileDiagnostics.update(kind, diagnostics);
      this.currentDiagnostics.set(uri, fileDiagnostics);
      didUpdate = true;
    }

    if (didUpdate) {
      const sendDiagnostics = (uri: string): void => {
        const fileDiagnostics = this.currentDiagnostics.get(uri);
        this.connection.sendDiagnostics({
          uri,
          diagnostics: fileDiagnostics ? fileDiagnostics.get() : [],
        });
      };

      const sendDiagnosticsDebounced = debounce(sendDiagnostics, 50);

      sendDiagnosticsDebounced(uri);
    }
  }

  private deleteDiagnostics(uri: string): void {
    this.currentDiagnostics.delete(uri);
    this.connection.sendDiagnostics({
      uri,
      diagnostics: [],
    });
  }

  private async getDiagnostics(
    { document }: { document: TextDocument },
    isSaveOrOpen: boolean,
    elmAnalyseTrigger: ElmAnalyseTrigger,
  ): Promise<void> {
    this.connection.console.info(
      `Diagnostics were requested due to a file ${
        isSaveOrOpen ? "open or save" : "change"
      }`,
    );

    const uri = URI.parse(document.uri);

    const text = document.getText();

    if (isSaveOrOpen) {
      const elmMakeDiagnostics = await this.elmMakeDiagnostics.createDiagnostics(
        uri,
      );

      this.resetDiagnostics(elmMakeDiagnostics, DiagnosticKind.ElmMake);

      elmMakeDiagnostics.forEach((diagnostics, diagnosticsUri) => {
        this.updateDiagnostics(
          diagnosticsUri,
          DiagnosticKind.ElmMake,
          diagnostics,
        );
      });
    }

    const elmMakeDiagnosticsForCurrentFile =
      this.currentDiagnostics
        .get(uri.toString())
        ?.getForKind(DiagnosticKind.ElmMake) ?? [];

    if (
      this.elmAnalyseDiagnostics &&
      elmAnalyseTrigger !== "never" &&
      (!elmMakeDiagnosticsForCurrentFile ||
        (elmMakeDiagnosticsForCurrentFile &&
          elmMakeDiagnosticsForCurrentFile.length === 0))
    ) {
      await this.elmAnalyseDiagnostics.updateFile(uri, text);
    }
  }

  private resetDiagnostics(
    diagnosticList: Map<string, Diagnostic[]>,
    diagnosticKind: DiagnosticKind,
  ): void {
    this.currentDiagnostics.forEach((fileDiagnostics, diagnosticsUri) => {
      if (
        !diagnosticList.has(diagnosticsUri) &&
        fileDiagnostics.getForKind(diagnosticKind).length > 0
      ) {
        diagnosticList.set(diagnosticsUri, []);
      }
    });
  }
}
