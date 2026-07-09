// Pure helper: pick the next auto-generated profile name (used by "New Profile"
// in the app menu). Proper naming/renaming will come with the settings manager.

export function nextProfileName(existing: string[]): string {
  let n = 2
  let name = `profile-${n}`
  while (existing.includes(name)) name = `profile-${++n}`
  return name
}
