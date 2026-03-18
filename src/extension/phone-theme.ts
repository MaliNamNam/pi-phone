type ThemeLike = {
  name?: string;
  getFgAnsi: (...args: any[]) => string | undefined;
};

function rgbToHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function xterm256ToHex(index: number) {
  const ansi16 = [
    "#000000",
    "#800000",
    "#008000",
    "#808000",
    "#000080",
    "#800080",
    "#008080",
    "#c0c0c0",
    "#808080",
    "#ff0000",
    "#00ff00",
    "#ffff00",
    "#0000ff",
    "#ff00ff",
    "#00ffff",
    "#ffffff",
  ];

  if (index >= 0 && index < ansi16.length) {
    return ansi16[index];
  }

  if (index >= 16 && index <= 231) {
    const cube = [0, 95, 135, 175, 215, 255];
    const value = index - 16;
    const r = cube[Math.floor(value / 36)] ?? 0;
    const g = cube[Math.floor((value % 36) / 6)] ?? 0;
    const b = cube[value % 6] ?? 0;
    return rgbToHex(r, g, b);
  }

  if (index >= 232 && index <= 255) {
    const gray = 8 + (index - 232) * 10;
    return rgbToHex(gray, gray, gray);
  }

  return "";
}

function ansiColorToCss(value: string | undefined) {
  if (!value) return "";

  const trueColorMatch = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(value);
  if (trueColorMatch) {
    return rgbToHex(Number(trueColorMatch[1]), Number(trueColorMatch[2]), Number(trueColorMatch[3]));
  }

  const color256Match = /\x1b\[38;5;(\d+)m/.exec(value);
  if (color256Match) {
    return xterm256ToHex(Number(color256Match[1]));
  }

  return "";
}

export function buildThemePayload(theme?: ThemeLike | null) {
  if (!theme) return null;

  const colors = {
    accent: ansiColorToCss(theme.getFgAnsi("accent")),
    mdCode: ansiColorToCss(theme.getFgAnsi("mdCode")),
    mdCodeBlock: ansiColorToCss(theme.getFgAnsi("mdCodeBlock")),
    mdCodeBlockBorder: ansiColorToCss(theme.getFgAnsi("mdCodeBlockBorder")),
  };

  if (!Object.values(colors).some(Boolean)) {
    return null;
  }

  return {
    name: theme.name || "",
    colors,
  };
}
