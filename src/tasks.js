export const STORAGE_KEY = "taskspace.tasks.v1";

export function readTasks(storage) {
  try {
    const saved = (storage ?? window.localStorage).getItem(STORAGE_KEY);
    if (saved === null) return { tasks: [], error: "" };
    const tasks = JSON.parse(saved);
    const ids = new Set();
    if (
      !Array.isArray(tasks) ||
      !tasks.every((task) => {
        if (
          !task ||
          typeof task.id !== "string" ||
          !task.id ||
          ids.has(task.id) ||
          typeof task.title !== "string" ||
          !task.title.trim() ||
          typeof task.completed !== "boolean"
        )
          return false;
        ids.add(task.id);
        return true;
      })
    )
      throw new Error("Invalid saved tasks");
    return { tasks, error: "" };
  } catch {
    return {
      tasks: [],
      error:
        "Your saved tasks could not be loaded. You can still add tasks, but saving changes will replace the previous list.",
    };
  }
}

export function filterTasks(tasks, filter, search) {
  const query = search.trim().toLocaleLowerCase();
  return tasks.filter(
    (task) =>
      (filter === "All" ||
        (filter === "Completed" ? task.completed : !task.completed)) &&
      task.title.toLocaleLowerCase().includes(query),
  );
}
