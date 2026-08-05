import chinese from "./chinese.js";
import english from "./english.js";
import spanish from "./spanish.js";
import uyghur from "./uyghur.js";

export const DEFAULT_DISPLAY_LANGUAGE = "english";

export const LOCALES = {
  english,
  uyghur,
  chinese,
  spanish,
};

export const DISPLAY_LANGUAGE_OPTIONS = [
  { code: "uyghur", label: uyghur.nativeName },
  { code: "chinese", label: chinese.nativeName },
  { code: "english", label: english.nativeName },
  { code: "spanish", label: spanish.nativeName },
];
