import { useTranslation } from "react-i18next";
import {
  runnerStatusKey,
  controlStatusKey,
  type RunnerStatusValue,
  type ControlStatusValue,
} from "@oxygen/shared";

/** Translate a runner status value to its localized label */
export function useRunnerStatusLabel() {
  const { t } = useTranslation("status");
  return (status: RunnerStatusValue): string =>
    t(`runner.${runnerStatusKey(status)}`);
}

/** Translate a runner status value to its localized description */
export function useRunnerStatusDescription() {
  const { t } = useTranslation("status");
  return (status: RunnerStatusValue): string =>
    t(`runnerDescription.${runnerStatusKey(status)}`);
}

/** Translate a control status value to its localized label */
export function useControlStatusLabel() {
  const { t } = useTranslation("status");
  return (status: ControlStatusValue): string =>
    t(`control.${controlStatusKey(status)}`);
}
