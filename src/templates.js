"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { makeBehaviorSpec, makeJudgeSpec } = require("./judges");
const { makeBucketSpec, makeDatasetSpec } = require("./datasets");
const { makeRuleSpec } = require("./rules");

const TEMPLATE_DIR = path.resolve(__dirname, "..", "templates");

function slug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function templateFiles() {
  if (!fs.existsSync(TEMPLATE_DIR)) return [];
  return fs.readdirSync(TEMPLATE_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(TEMPLATE_DIR, name));
}

function listTemplates() {
  return templateFiles().map((file) => {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      id: slug(data.name || path.basename(file, ".json")),
      name: data.name || path.basename(file, ".json"),
      description: data.description || null,
      file
    };
  });
}

function loadTemplate(nameOrPath) {
  const direct = path.resolve(nameOrPath);
  let file = fs.existsSync(direct) ? direct : null;
  if (!file) {
    const wanted = slug(nameOrPath);
    file = templateFiles().find((candidate) => {
      const data = JSON.parse(fs.readFileSync(candidate, "utf8"));
      return slug(data.name || path.basename(candidate, ".json")) === wanted;
    });
  }
  if (!file) throw new Error(`Unknown template: ${nameOrPath}`);
  return { file, data: JSON.parse(fs.readFileSync(file, "utf8")) };
}

function installTemplate(store, nameOrPath) {
  const { data } = loadTemplate(nameOrPath);
  const judges = new Map();
  const behaviors = new Map();
  const datasets = new Map();
  const installed = { judges: 0, behaviors: 0, datasets: 0, buckets: 0, rules: 0 };

  for (const input of data.judges || []) {
    const spec = makeJudgeSpec(input);
    store.upsertJudge(spec);
    judges.set(input.name, spec.judge.id);
    judges.set(spec.judge.id, spec.judge.id);
    installed.judges += 1;
  }

  for (const input of data.behaviors || []) {
    const behavior = makeBehaviorSpec({
      ...input,
      judgeId: input.judgeId || judges.get(input.judge) || input.judge
    });
    store.upsertBehavior(behavior);
    behaviors.set(input.name, behavior.id);
    behaviors.set(behavior.id, behavior.id);
    installed.behaviors += 1;
  }

  for (const input of data.datasets || []) {
    const dataset = makeDatasetSpec(input);
    store.upsertDataset(dataset);
    datasets.set(input.name, dataset.id);
    datasets.set(dataset.id, dataset.id);
    installed.datasets += 1;
  }

  for (const input of data.buckets || []) {
    const bucket = makeBucketSpec({
      ...input,
      datasetId: input.datasetId || datasets.get(input.dataset) || input.dataset,
      behaviorId: input.behaviorId || behaviors.get(input.behavior) || input.behavior
    });
    store.upsertBucket(bucket);
    installed.buckets += 1;
  }

  for (const input of data.rules || []) {
    const rule = makeRuleSpec({
      ...input,
      behaviorId: input.behaviorId || behaviors.get(input.behavior) || input.behavior
    });
    store.upsertRule(rule);
    installed.rules += 1;
  }

  return { template: data.name, installed };
}

module.exports = {
  installTemplate,
  listTemplates,
  loadTemplate
};
