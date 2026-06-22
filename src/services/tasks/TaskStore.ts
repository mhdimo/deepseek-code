// TaskStore — in-memory task management for the task tools
//
// Simple class that stores TaskItem objects with auto-incrementing IDs.
// No persistence — tasks live only for the duration of the session.

import type { TaskItem } from "../../types/index.js";

let nextId = 1;

export class TaskStore {
  private tasks: Map<string, TaskItem> = new Map();

  /** Create a new task and return it */
  create(
    subject: string,
    description: string,
    activeForm?: string,
  ): TaskItem {
    const id = String(nextId++);
    const now = Date.now();
    const task: TaskItem = {
      id,
      subject,
      description,
      status: "pending",
      activeForm,
      blocks: [],
      blockedBy: [],
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(id, task);
    return task;
  }

  /** Get a single task by ID */
  get(id: string): TaskItem | undefined {
    return this.tasks.get(id);
  }

  /** Update a task's fields */
  update(
    id: string,
    updates: Partial<
      Omit<TaskItem, "id" | "createdAt"> & {
        addBlocks?: string[];
        addBlockedBy?: string[];
      }
    >,
  ): TaskItem | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;

    // Handle status="deleted" as removal
    if (updates.status === ("deleted" as any)) {
      this.tasks.delete(id);
      return undefined;
    }

    const now = Date.now();

    // Handle addBlocks / addBlockedBy by merging
    if (updates.addBlocks) {
      task.blocks = [...new Set([...task.blocks, ...updates.addBlocks])];
      delete (updates as any).addBlocks;
    }
    if (updates.addBlockedBy) {
      task.blockedBy = [...new Set([...task.blockedBy, ...updates.addBlockedBy])];
      delete (updates as any).addBlockedBy;
    }

    Object.assign(task, updates, { updatedAt: now });
    return task;
  }

  /** Delete a task by ID */
  delete(id: string): boolean {
    return this.tasks.delete(id);
  }

  /** List all tasks */
  list(): TaskItem[] {
    return Array.from(this.tasks.values());
  }

  /** Reset the store (useful for testing) */
  clear(): void {
    this.tasks.clear();
    nextId = 1;
  }
}
