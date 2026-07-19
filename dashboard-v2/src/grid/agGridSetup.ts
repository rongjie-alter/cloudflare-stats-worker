// AG Grid Community — register all community modules once, and build a theme
// that follows the app's light/dark mode via the v33 Theming API.
import { ModuleRegistry, AllCommunityModule, themeQuartz, colorSchemeDark } from "ag-grid-community";

ModuleRegistry.registerModules([AllCommunityModule]);

export const lightTheme = themeQuartz;
export const darkTheme = themeQuartz.withPart(colorSchemeDark);

export function gridTheme(theme: "light" | "dark") {
  return theme === "dark" ? darkTheme : lightTheme;
}
