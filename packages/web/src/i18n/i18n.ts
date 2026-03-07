import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enCommon from "./locales/en/common.json";
import enNav from "./locales/en/nav.json";
import enDashboard from "./locales/en/dashboard.json";
import enRunners from "./locales/en/runners.json";
import enResults from "./locales/en/results.json";
import enCourses from "./locales/en/courses.json";
import enControls from "./locales/en/controls.json";
import enClasses from "./locales/en/classes.json";
import enClubs from "./locales/en/clubs.json";
import enRegistration from "./locales/en/registration.json";
import enRace from "./locales/en/race.json";
import enKiosk from "./locales/en/kiosk.json";
import enReceipt from "./locales/en/receipt.json";
import enDraw from "./locales/en/draw.json";
import enEvent from "./locales/en/event.json";
import enDevices from "./locales/en/devices.json";
import enStatus from "./locales/en/status.json";

import svCommon from "./locales/sv/common.json";
import svNav from "./locales/sv/nav.json";
import svDashboard from "./locales/sv/dashboard.json";
import svRunners from "./locales/sv/runners.json";
import svResults from "./locales/sv/results.json";
import svCourses from "./locales/sv/courses.json";
import svControls from "./locales/sv/controls.json";
import svClasses from "./locales/sv/classes.json";
import svClubs from "./locales/sv/clubs.json";
import svRegistration from "./locales/sv/registration.json";
import svRace from "./locales/sv/race.json";
import svKiosk from "./locales/sv/kiosk.json";
import svReceipt from "./locales/sv/receipt.json";
import svDraw from "./locales/sv/draw.json";
import svEvent from "./locales/sv/event.json";
import svDevices from "./locales/sv/devices.json";
import svStatus from "./locales/sv/status.json";

export const defaultNS = "common" as const;

export const resources = {
  en: {
    common: enCommon,
    nav: enNav,
    dashboard: enDashboard,
    runners: enRunners,
    results: enResults,
    courses: enCourses,
    controls: enControls,
    classes: enClasses,
    clubs: enClubs,
    registration: enRegistration,
    race: enRace,
    kiosk: enKiosk,
    receipt: enReceipt,
    draw: enDraw,
    event: enEvent,
    devices: enDevices,
    status: enStatus,
  },
  sv: {
    common: svCommon,
    nav: svNav,
    dashboard: svDashboard,
    runners: svRunners,
    results: svResults,
    courses: svCourses,
    controls: svControls,
    classes: svClasses,
    clubs: svClubs,
    registration: svRegistration,
    race: svRace,
    kiosk: svKiosk,
    receipt: svReceipt,
    draw: svDraw,
    event: svEvent,
    devices: svDevices,
    status: svStatus,
  },
} as const;

i18n.use(initReactI18next).init({
  resources,
  lng: localStorage.getItem("oxygen-lang") || "en",
  fallbackLng: "en",
  defaultNS,
  interpolation: { escapeValue: false },
});

export default i18n;
