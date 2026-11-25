// Expo's Metro config detects the pnpm workspace by itself (watch folders, the hoisted node_modules), and resolves the ".ts"
// specifiers @dorks/client uses as written, so the workspace packages need nothing extra here.
const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
