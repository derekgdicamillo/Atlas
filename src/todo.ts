/**
 * Atlas — Obsidian Todo Integration
 *
 * Reads and writes Derek's MASTER TODO.md in his Obsidian vault.
 * Since Atlas runs on Derek's machine, direct file I/O works.
 * OneDrive syncs the vault automatically.
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { info, error as logError } from "./logger.ts";

const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT || "";
const TODO_FILE = OBSIDIAN_VAULT
  ? join(OBSIDIAN_VAULT, "MASTER TODO.md")
  : "";

/**
 * Read the full MASTER TODO.md content.
 */
export async function readTodoFile(): Promise<string> {
  if (!TODO_FILE) return "";
  try {
    return await readFile(TODO_FILE, "utf-8");
  } catch (err) {
    logError("todo", `Failed to read TODO file: ${err}`);
    return "";
  }
}

/**
 * Get a truncated summary of current tasks for prompt context.
 * Includes INBOX, TODAY, THIS WEEK sections only (keeps token count low).
 */
export async function getTodoContext(): Promise<string> {
  const content = await readTodoFile();
  if (!content) return "";

  const sections = ["INBOX", "TODAY", "THIS WEEK"];
  const lines = content.split("\n");
  const contextLines: string[] = ["CURRENT TASKS:"];
  let inRelevantSection = false;
  let itemCount = 0;
  const MAX_ITEMS = 15;

  for (const line of lines) {
    if (line.startsWith("## ")) {
      const sectionName = line.replace("## ", "").split("(")[0].trim();
      inRelevantSection = sections.some((s) =>
        sectionName.toUpperCase().startsWith(s)
      );
      if (inRelevantSection) {
        contextLines.push(line);
      }
      continue;
    }

    if (inRelevantSection && line.trim().startsWith("- [")) {
      if (itemCount < MAX_ITEMS) {
        contextLines.push(line);
        itemCount++;
      }
    }
  }

  return itemCount > 0 ? contextLines.join("\n") : "";
}

/**
 * Add a task to the INBOX section of MASTER TODO.md.
 */
export async function addTodo(taskText: string): Promise<boolean> {
  if (!TODO_FILE) return false;

  try {
    const content = await readFile(TODO_FILE, "utf-8");
    const lines = content.split("\n");

    // Find the INBOX section
    const inboxIdx = lines.findIndex((l) => l.startsWith("## INBOX"));

    if (inboxIdx === -1) {
      logError("todo", "Could not find INBOX section in MASTER TODO.md");
      return false;
    }

    // Insert after INBOX header, before existing items
    let insertIdx = inboxIdx + 1;

    // Skip any existing empty checkboxes
    while (
      insertIdx < lines.length &&
      lines[insertIdx].trim() === "- [ ]"
    ) {
      insertIdx++;
    }

    lines.splice(insertIdx, 0, `- [ ] ${taskText}`);

    await writeFile(TODO_FILE, lines.join("\n"), "utf-8");
    info("todo", `Added: ${taskText}`);
    return true;
  } catch (err) {
    logError("todo", `Failed to add task: ${err}`);
    return false;
  }
}

/**
 * Mark a task as done by searching for matching text.
 * Changes `- [ ]` to `- [x]` on the first match.
 */
export async function completeTodo(searchText: string): Promise<boolean> {
  if (!TODO_FILE) return false;

  try {
    const content = await readFile(TODO_FILE, "utf-8");
    const lines = content.split("\n");
    const searchLower = searchText.toLowerCase();
    let found = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (
        line.trim().startsWith("- [ ]") &&
        line.toLowerCase().includes(searchLower)
      ) {
        lines[i] = line.replace("- [ ]", "- [x]");
        found = true;
        info("todo", `Completed: ${line.trim()}`);
        break;
      }
    }

    if (found) {
      await writeFile(TODO_FILE, lines.join("\n"), "utf-8");
    } else {
      info("todo", `No matching unchecked task for: ${searchText}`);
    }

    return found;
  } catch (err) {
    logError("todo", `Failed to complete task: ${err}`);
    return false;
  }
}
