export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

// Name shown and sent for a file: includes its folder path when it came from a picked folder.
// `relativePath` is set by FilePicker for dropped folders; `webkitRelativePath` by the folder input.
export function fileLabel(file) {
  return file.relativePath || file.webkitRelativePath || file.name;
}

// Last part of a path, for saving a single file ("Trip/IMG_1.jpg" -> "IMG_1.jpg").
export const baseName = (path) => path.split('/').pop() || 'file';
