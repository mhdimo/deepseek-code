




import type { TaskItem } from "../../types/index.js";

let nextId = 1;

export class TaskStore {
  private tasks: Map<string, TaskItem> = new Map();

  
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

  
  get(id: string): TaskItem | undefined {
    return this.tasks.get(id);
  }

  
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

    
    if (updates.status === ("deleted" as any)) {
      this.tasks.delete(id);
      return undefined;
    }

    const now = Date.now();

    
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

  
  delete(id: string): boolean {
    return this.tasks.delete(id);
  }

  
  list(): TaskItem[] {
    return Array.from(this.tasks.values());
  }

  
  clear(): void {
    this.tasks.clear();
    nextId = 1;
  }
}
