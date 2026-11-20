import { analyzeMatchCore, MODEL_VERSION } from "./core.js";
import { buildExplanations } from "./explain.js";

export function analyzeMatch(match, teams, league) {
  const analysis = analyzeMatchCore(match, teams, league);
  analysis.explanations = buildExplanations(analysis);
  return analysis;
}

export { MODEL_VERSION };
