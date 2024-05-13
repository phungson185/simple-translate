import browser from "webextension-polyfill";
import log from "loglevel";
import axios from "axios";
import { getSettings } from "src/settings/settings";
import { JAPANESE_REGEX } from "./constants";

let translationHistory = [];

const logDir = "common/translate";

const getHistory = (sourceWord, sourceLang, targetLang, translationApi) => {
  const history = translationHistory.find(
    (history) =>
      history.sourceWord == sourceWord &&
      history.sourceLang == sourceLang &&
      history.targetLang == targetLang &&
      history.translationApi == translationApi &&
      !history.result.isError
  );
  return history;
};

const setHistory = (
  sourceWord,
  sourceLang,
  targetLang,
  translationApi,
  result
) => {
  translationHistory.push({
    sourceWord: sourceWord,
    sourceLang: sourceLang,
    targetLang: targetLang,
    translationApi: translationApi,
    result: result,
  });
};

const sendRequestToGoogle = async (word, sourceLang, targetLang) => {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&dt=bd&dj=1&q=${encodeURIComponent(
    word
  )}`;
  const result = await axios.get(url).catch((error) => error.response);

  const resultData = {
    resultText: "",
    candidateText: "",
    sourceLanguage: "",
    percentage: 0,
    isError: false,
    errorMessage: "",
  };

  if (!result || result?.status !== 200) {
    resultData.isError = true;

    if (!result || result.status === 0)
      resultData.errorMessage = browser.i18n.getMessage("networkError");
    else if (result.status === 429 || result.status === 503)
      resultData.errorMessage = browser.i18n.getMessage("unavailableError");
    else
      resultData.errorMessage = `${browser.i18n.getMessage("unknownError")} [${
        result?.status
      } ${result?.statusText}]`;

    log.error(logDir, "sendRequest()", result);
    return resultData;
  }

  resultData.sourceLanguage = result.data.src;
  resultData.percentage = result.data.ld_result.srclangs_confidences[0];
  resultData.resultText = result.data.sentences
    .map((sentence) => sentence.trans)
    .join("");
  if (result.data.dict) {
    resultData.candidateText = result.data.dict
      .map(
        (dict) =>
          `${dict.pos}${dict.pos != "" ? ": " : ""}${
            dict.terms !== undefined ? dict.terms.join(", ") : ""
          }\n`
      )
      .join("");
  }

  log.log(logDir, "sendRequest()", resultData);
  return resultData;
};

const sendRequestToDeepL = async (word, sourceLang, targetLang) => {
  let params = new URLSearchParams();
  const authKey = getSettings("deeplAuthKey");
  params.append("auth_key", authKey);
  params.append("text", word);
  params.append("target_lang", targetLang);
  const url =
    getSettings("deeplPlan") === "deeplFree"
      ? "https://api-free.deepl.com/v2/translate"
      : "https://api.deepl.com/v2/translate";
  const result = await axios.post(url, params).catch((e) => e.response);

  const resultData = {
    resultText: "",
    candidateText: "",
    sourceLanguage: "",
    percentage: 0,
    isError: false,
    errorMessage: "",
  };

  if (!result || result?.status !== 200) {
    resultData.isError = true;

    if (!result || result.status === 0)
      resultData.errorMessage = browser.i18n.getMessage("networkError");
    else if (result.status === 403)
      resultData.errorMessage = browser.i18n.getMessage("deeplAuthError");
    else
      resultData.errorMessage = `${browser.i18n.getMessage("unknownError")} [${
        result?.status
      } ${result?.statusText}] ${result?.data.message}`;

    log.error(logDir, "sendRequestToDeepL()", result);
    return resultData;
  }

  resultData.resultText = result.data.translations[0].text;
  resultData.sourceLanguage =
    result.data.translations[0].detected_source_language.toLowerCase();
  resultData.percentage = 1;

  log.log(logDir, "sendRequestToDeepL()", resultData);
  return resultData;
};

const sendRequestToMazii = async (word) => {
  try {
    const wordIds = await axios.post("https://mazii.net/api/search", {
      dict: "javi",
      type: "word",
      query: word,
      limit: 20,
      page: 1,
    });

    log.log(logDir, "sendRequestToMazii() - wordIds", wordIds);

    if (
      !wordIds?.data?.found ||
      wordIds?.data?.status !== 200 ||
      !wordIds?.data?.data?.length
    ) {
      return [];
    }

    const wordId = wordIds?.data?.data[0]?.mobileId || Math.random();

    const result = await axios.post("https://api.mazii.net/api/get-mean", {
      dict: "javi",
      type: "word",
      wordId,
      word,
    });

    log.log(logDir, "sendRequestToMazii() - comments", result);

    if (!result?.data?.result?.length || result?.data?.status !== 200) {
      return [];
    }

    return result?.data?.result?.map(({ mean, like, dislike, username }) => ({
      mean,
      like,
      dislike,
      username,
    }));
  } catch (error) {
    log.log(logDir, "sendRequestToMazii()", error);
  }
};

export default async (
  sourceWord,
  sourceLang = "auto",
  targetLang,
  translationApi
) => {
  log.log(logDir, "tranlate()", sourceWord, targetLang, translationApi);
  sourceWord = sourceWord.trim();
  if (sourceWord === "")
    return {
      resultText: "",
      candidateText: "",
      sourceLanguage: "en",
      percentage: 0,
      statusText: "OK",
    };

  const history = getHistory(sourceWord, sourceLang, targetLang);
  if (history) return history.result;

  let resultMazii = null;

  const resultGg =
    getSettings("translationApi") === "google"
      ? await sendRequestToGoogle(sourceWord, sourceLang, targetLang)
      : await sendRequestToDeepL(sourceWord, sourceLang, targetLang);

  if (sourceWord.match(JAPANESE_REGEX)) {
    resultMazii = await sendRequestToMazii(sourceWord);
  }

  if (resultMazii) {
    setHistory(sourceWord, sourceLang, targetLang, translationApi, {
      resultGg,
      resultMazii,
    });
    return { resultGg, resultMazii };
  }

  setHistory(sourceWord, sourceLang, targetLang, translationApi, { resultGg });
  return { resultGg };
};
