import { pathToFileURL } from "node:url";
import type { MigrationFolder } from "@bodhchakra/db";

export {
  type CheckedImage,
  checkImage,
  IMAGE_TYPES,
  type ImageCheck,
  type ImageType,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_SIDE,
} from "./image.ts";
export {
  createStorage,
  SIGNED_URL_SECONDS,
  type Storage,
  type StorageConfig,
  StorageError,
  type StoredObject,
} from "./storage.ts";

/** The object table's migrations; an app lists them before its own tables, which reference them. */
export const migrations: MigrationFolder = {
  name: "storage",
  dir: pathToFileURL(`${import.meta.dirname}/../migrations/`),
};
