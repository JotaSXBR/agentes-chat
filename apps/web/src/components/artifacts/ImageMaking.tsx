import { Icon } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";

/**
 * Where a picture an agent is making will show, while it makes it (`makingImage`): the box of a lone picture in a
 * reply, with a grain that develops across it, until the reply takes its place with the picture. Its image tool says
 * nothing until it is done, so there is no progress to show, only that it is on its way.
 */
export function ImageMaking() {
  const { t } = useTranslation();
  return (
    <div className="artifact-cards">
      <div className="image-making" role="status">
        <span className="image-making__grain" aria-hidden="true" />
        <span className="image-making__label ac-iconline">
          <Icon name="image" size={16} />
          {t("files.imageMaking")}
        </span>
      </div>
    </div>
  );
}
