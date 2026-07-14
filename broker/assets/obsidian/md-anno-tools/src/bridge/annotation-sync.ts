import { Notice } from "obsidian";
import { ANNO_TAG_PREFIX, ANNO_TAG_SUFFIX } from "../core/constants";
import { fetchJson, joinUrl, postJson, writeTextToClipboard } from "../core/api";
import { parseAmoMetadata } from "../core/metadata";
import { getVaultRoot, messageFromError, previewText } from "../core/ui-utils";
import { extractAnnotationContents, formatAnnotationsForClipboard } from "../annotations/syntax";

function bridgeUrl(context) {
  return context && context.settings ? context.settings.bridgeUrl : "";
}

function shouldNumberAnnotations(context) {
  return Boolean(context && context.settings && context.settings.numberAnnotationsInPrompt);
}

function shouldUseSafeCliPaste(context) {
  return !context || !context.settings || context.settings.safeCliPaste !== false;
}

export async function copyAnnotationsFromFileAction(context, file) {
  const markdown = await context.app.vault.cachedRead(file as any);
  const annotations = extractAnnotationContents(markdown);
  context.debugLog("annotations.copy.extract", {
    notePath: file.path,
    annotationCount: annotations.length,
    annotationPreviews: annotations.slice(0, 5).map((annotation) => previewText(annotation)),
    activeLeafType: context.activeLeafType(),
  });
  if (annotations.length === 0) {
    new Notice("No annotations found in the current note.");
    return;
  }

  try {
    await writeTextToClipboard(formatAnnotationsForClipboard(annotations, shouldUseSafeCliPaste(context)));
    context.debugLog("annotations.copy.ok", {
      notePath: file.path,
      annotationCount: annotations.length,
    });
    context.setOperationStatus("Copied " + annotations.length + " annotation(s) from " + file.path + ".", "success");
    new Notice("Copied " + annotations.length + " annotation(s).");
  } catch (error) {
    console.error("Failed to copy annotations:", error);
    context.debugLog("annotations.copy.error", {
      notePath: file.path,
      message: messageFromError(error),
    });
    context.setOperationStatus("Copy failed: " + messageFromError(error), "error");
    new Notice("Copy failed: " + messageFromError(error));
  }
}

export async function sendAnnotationsFromFileAction(context, file) {
  const sendStartedAtMs = Date.now();
  context.debugLog("annotations.send.prepare_start", {
    notePath: file.path,
    startedAtMs: sendStartedAtMs,
  });
  const readStartedAtMs = Date.now();
  const markdown = await context.app.vault.cachedRead(file as any);
  const readDurationMs = Date.now() - readStartedAtMs;
  const extractStartedAtMs = Date.now();
  const annotations = extractAnnotationContents(markdown);
  const extractDurationMs = Date.now() - extractStartedAtMs;
  context.debugLog("annotations.extract", {
    notePath: file.path,
    annotationCount: annotations.length,
    annotationPreviews: annotations.slice(0, 5).map((annotation) => previewText(annotation)),
    markdownHasAnnoOpen: markdown.includes(ANNO_TAG_PREFIX),
    markdownHasAnnoClose: markdown.includes(ANNO_TAG_SUFFIX),
    readDurationMs,
    extractDurationMs,
    elapsedMs: Date.now() - sendStartedAtMs,
  });
  const amo = parseAmoMetadata(markdown);
  context.debugLog("annotations.metadata", {
    notePath: file.path,
    sessionId: amo.sessionId || null,
    turnId: amo.turnId || null,
  });
  if (!amo.sessionId) {
    new Notice("This note is missing AMO session metadata.");
    return;
  }

  if (annotations.length === 0) {
    try {
      await postJson(joinUrl(bridgeUrl(context), "/api/obsidian/return"), {
        schemaVersion: 1,
        source: "obsidian-md-anno-tools",
        vaultRoot: getVaultRoot(context.app),
        notePath: file.path,
        sessionId: amo.sessionId,
        turnId: amo.turnId || null,
      });
      context.debugLog("annotations.return.ok", {
        notePath: file.path,
        sessionId: amo.sessionId,
      });
      context.setOperationStatus("Returning to the task window for " + file.path + ".", "success");
    } catch (error) {
      context.debugLog("annotations.return.error", {
        notePath: file.path,
        sessionId: amo.sessionId,
        message: messageFromError(error),
      });
      context.setOperationStatus("Return failed: " + messageFromError(error), "error");
      new Notice("Return to task window failed: " + messageFromError(error));
    }
    return;
  }

  const payload = {
    schemaVersion: 1,
    source: "obsidian-md-anno-tools",
    vaultRoot: getVaultRoot(context.app),
    notePath: file.path,
    sessionId: amo.sessionId,
    turnId: amo.turnId || null,
    promptOptions: {
      numberAnnotations: shouldNumberAnnotations(context),
      safeCliPaste: shouldUseSafeCliPaste(context),
    },
    annotations: annotations.map((content, index) => ({
      index: index + 1,
      content,
    })),
  };

  try {
    const postStartedAtMs = Date.now();
    context.debugLog("annotations.send.start", {
      notePath: file.path,
      sessionId: payload.sessionId,
      turnId: payload.turnId,
      annotationCount: payload.annotations.length,
      elapsedMs: postStartedAtMs - sendStartedAtMs,
    });
    const result = await postJson(joinUrl(bridgeUrl(context), "/api/obsidian/annotations"), payload);
    context.debugLog("annotations.send.ok", {
      notePath: file.path,
      sessionId: payload.sessionId,
      pendingPromptId: result.pendingPromptId || null,
      annotationCount: payload.annotations.length,
      postDurationMs: Date.now() - postStartedAtMs,
      totalDurationMs: Date.now() - sendStartedAtMs,
    });
    context.setOperationStatus(
      "Sent " + annotations.length + " annotation(s) from " + file.path + " to AMO.",
      "success"
    );
    new Notice(
      "Sent " +
        annotations.length +
        " annotation(s) to AMO" +
        (result.pendingPromptId ? ": " + result.pendingPromptId : ".")
    );
  } catch (error) {
    console.error("Failed to send annotations to AMO:", error);
    context.debugLog("annotations.send.error", {
      notePath: file.path,
      sessionId: payload.sessionId,
      message: messageFromError(error),
    });
    context.setOperationStatus("AMO sync failed: " + messageFromError(error), "error");
    new Notice("AMO sync failed: " + messageFromError(error));
  }
}

export async function checkBridgeHealthAction(context) {
  try {
    const result = await fetchJson(joinUrl(bridgeUrl(context), "/api/health"));
    context.setOperationStatus(
      "Bridge online: " + (result.service || "AMO") + " on port " + (result.port || "unknown") + ".",
      "success"
    );
    new Notice("AMO bridge is online.");
  } catch (error) {
    context.setOperationStatus("Bridge check failed: " + messageFromError(error), "error");
    new Notice("AMO bridge check failed: " + messageFromError(error));
  }
}
