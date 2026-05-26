"use strict";

const crypto = require("node:crypto");

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function repoFromSession(session) {
  const cwd = session.cwd || session.sourcePath || "";
  const match = cwd.match(/\/Users\/[^/]+\/projects\/([^/]+)/);
  if (match) return match[1];
  const claudeMatch = cwd.match(/\.claude\/projects\/-Users-[^-]+-projects-([^/]+)/);
  if (claudeMatch) return claudeMatch[1];
  return null;
}

function makeLesson(input) {
  const createdAt = new Date().toISOString();
  return {
    id: hash(JSON.stringify([input.category, input.scope, input.repo, input.title, input.sourceSessionId, input.sourceEventId])),
    createdAt,
    ...input
  };
}

function lessonFromAnnotation(row) {
  const text = `${row.summary || ""}\n${row.searchText || ""}\n${row.reason || ""}`;
  const repo = repoFromSession(row);

  if (/ModuleNotFoundError|No module named|missing dependency|dependency failures?|scorer (crashed|crash|health|import)|zero-score|evaluator[- ]health|evaluator\/scorer health/i.test(text)) {
    return makeLesson({
      category: "gate",
      scope: "repo",
      repo,
      title: "Separate evaluator health from candidate quality",
      lesson: "Evaluator/scorer crashes must abort or become evaluator-health failures, not candidate zero-score evidence.",
      evidence: [row.summary],
      action: "Add a preflight health gate and classify scorer dependency/import failures separately.",
      confidence: 0.95,
      sourceSessionId: row.sessionId,
      sourceEventId: row.eventId
    });
  }

  if (/full e2e|rerun|Fix and rerun|new goal|make this a new/i.test(text)) {
    return makeLesson({
      category: "eval",
      scope: "workflow",
      repo,
      title: "Treat full E2E as a first-class completion criterion",
      lesson: "The user frequently steers agents from local edits/checks toward full end-to-end validation with comparison evidence.",
      evidence: [row.summary],
      action: "Add a workflow gate that requires an actual E2E run, previous-run comparison, and written audit before claiming completion.",
      confidence: 0.9,
      sourceSessionId: row.sessionId,
      sourceEventId: row.eventId
    });
  }

  if (row.kind === "loop") {
    return makeLesson({
      category: "tool",
      scope: "agent",
      repo,
      title: "Detect repeated low-progress command loops",
      lesson: "Repeated identical commands within a short window are a signal that the agent needs a different tool, summary, or user-visible checkpoint.",
      evidence: [row.summary],
      action: "Add loop detection that asks the agent to explain progress and choose a new strategy after repeated commands.",
      confidence: 0.75,
      sourceSessionId: row.sessionId,
      sourceEventId: row.eventId
    });
  }

  if (/Nah|instead|not right|wrong|you missed|actually/i.test(text)) {
    return makeLesson({
      category: "prompt",
      scope: "user",
      repo,
      title: "Capture user preference corrections as prompt rules",
      lesson: "Correction language from the user should become a candidate prompt rule or workflow preference after repeated occurrences.",
      evidence: [row.summary],
      action: "Review this correction and promote stable preferences into prompts or repo-local config.",
      confidence: 0.7,
      sourceSessionId: row.sessionId,
      sourceEventId: row.eventId
    });
  }

  if (row.kind === "failure") {
    return makeLesson({
      category: "gate",
      scope: "session",
      repo,
      title: "Promote recurring failure signatures into preflights",
      lesson: "Failures seen in trace data should become preflight checks or clearer error classifications when they repeat.",
      evidence: [row.summary],
      action: "Cluster this failure with nearby failures and decide whether it should become a preflight, retry rule, or diagnostic.",
      confidence: 0.6,
      sourceSessionId: row.sessionId,
      sourceEventId: row.eventId
    });
  }

  return null;
}

function distillWorkflows(store, options = {}) {
  const db = store.getDb();
  const limit = Math.max(1, Math.min(100000, Number(options.limit || 50000)));
  const rows = db.prepare(`
    SELECT a.*, s.cwd, s.sourcePath
    FROM annotations a
    LEFT JOIN sessions s ON s.id = a.sessionId
    ORDER BY a.timestamp DESC
    LIMIT $limit
  `).all({ $limit: limit });

  const lessons = new Map();
  for (const row of rows) {
    const lesson = lessonFromAnnotation(row);
    if (!lesson) continue;
    const key = `${lesson.category}:${lesson.repo || ""}:${lesson.title}:${lesson.sourceSessionId}`;
    const existing = lessons.get(key);
    if (!existing || lesson.confidence > existing.confidence) lessons.set(key, lesson);
  }

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM workflow_lessons").run();
    for (const lesson of lessons.values()) {
      db.prepare(`
        INSERT INTO workflow_lessons (
          id, category, scope, repo, title, lesson, evidence, action, confidence,
          sourceSessionId, sourceEventId, createdAt
        ) VALUES (
          $id, $category, $scope, $repo, $title, $lesson, $evidence, $action, $confidence,
          $sourceSessionId, $sourceEventId, $createdAt
        )
      `).run({
        $id: lesson.id,
        $category: lesson.category,
        $scope: lesson.scope,
        $repo: lesson.repo,
        $title: lesson.title,
        $lesson: lesson.lesson,
        $evidence: JSON.stringify(lesson.evidence),
        $action: lesson.action,
        $confidence: lesson.confidence,
        $sourceSessionId: lesson.sourceSessionId,
        $sourceEventId: lesson.sourceEventId,
        $createdAt: lesson.createdAt
      });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { annotationsRead: rows.length, lessons: lessons.size };
}

module.exports = {
  distillWorkflows
};
