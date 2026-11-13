import { useTranslation } from "react-i18next";
import { useBuildInfo, type BuildInfo } from "../hooks/useBuildInfo";
import {
  formatBuildCommit,
  formatBuildVersion,
  formatDeployRef,
} from "../lib/app-update";

/**
 * `Build: … · Image: … · Commit: …` for a known `/api/version` answer.
 * `Image:` is left out when the deploy ref is the running version's own
 * tag (docs/releases-and-images.md, the footer block).
 */
export function BuildInfoText({
  info,
  className = "",
}: {
  info: BuildInfo | null;
  className?: string;
}) {
  const { t } = useTranslation("common");
  const commit = formatBuildCommit(info?.buildId);
  const image = info?.deployRef
    ? formatDeployRef(info.deployRef, info.version || __APP_VERSION__)
    : null;

  return (
    <div className={className} data-testid="build-version">
      {t("buildVersion")}: {formatBuildVersion(__BUILD_VERSION__)}
      {image && (
        <> · {t("imageVersion")}: {image}</>
      )}
      {commit && (
        <> · {t("commitVersion")}: {commit}</>
      )}
    </div>
  );
}

/** The build line that loads `/api/version` itself (the sync panel). */
export function BuildInfoLine({ className = "" }: { className?: string }) {
  return <BuildInfoText info={useBuildInfo()} className={className} />;
}
