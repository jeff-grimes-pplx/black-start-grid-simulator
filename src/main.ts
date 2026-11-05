import "./ui/styles.css";
import scenarioData from "./data/scenario.json";
import referenceActions from "./data/reference_actions.json";
import { App } from "./ui/app";
import type { Action, Scenario } from "./engine/types";

new App(scenarioData as unknown as Scenario, referenceActions as unknown as Action[]);
