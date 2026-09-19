import { useTranslation } from "react-i18next";
import { useBuildInfo } from "../hooks/useBuildInfo";
import {
  formatBuildCommit,
  formatBuildVersion,
  formatDeployRef,
} from "../lib/app-update";

export function BuildInfoLine({ className = "" }: { className?: string }) {
  const { t } = useTranslation("common");
  const info = useBuildInfo();
  const commit = formatBuildCommit(info?.buildId);

  return (
    <div className={className} data-testid="build-version">
      {t("buildVersion")}: {formatBuildVersion(__BUILD_VERSION__)}
      {info?.deployRef && (
        <> · {t("imageVersion")}: {formatDeployRef(info.deployRef)}</>
      )}
      {commit && (
        <> · {t("commitVersion")}: {commit}</>
      )}
    </div>
  );
}
