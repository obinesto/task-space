import { useEffect, useRef, useState } from "react";
import {
  Check,
  ClipboardList,
  Clock3,
  ListTodo,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { filterTasks, readTasks, STORAGE_KEY } from "../tasks";
import "./taskForm.css";

const filters = ["All", "Active", "Completed"];

const TaskForm = () => {
  const [initial] = useState(() => readTasks());
  const [tasks, setTasks] = useState(initial.tasks);
  const [storageError, setStorageError] = useState(initial.error);
  const [title, setTitle] = useState("");
  const [filter, setFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState("");
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const inputRef = useRef(null);
  const completed = tasks.filter((task) => task.completed).length;
  const visibleTasks = filterTasks(tasks, filter, search);
  const progress = tasks.length
    ? Math.round((completed / tasks.length) * 100)
    : 0;

  useEffect(() => {
    // Preserve saved data until the user changes the list.
    if (tasks === initial.tasks) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
      setStorageError("");
    } catch {
      setStorageError(
        "Your changes could not be saved in this browser. Keep this page open to retain them.",
      );
    }
  }, [tasks, initial]);

  function addTask(event) {
    event.preventDefault();
    const text = title.trim();
    if (!text) {
      setError("Enter a task before adding it.");
      inputRef.current?.focus();
      return;
    }
    setTasks((current) => [
      { id: crypto.randomUUID(), title: text, completed: false },
      ...current,
    ]);
    setTitle("");
    setError("");
    setAnnouncement(`Added: ${text}`);
    inputRef.current?.focus();
  }

  function saveTask(event, id) {
    event.preventDefault();
    const text = editTitle.trim();
    if (!text) return;
    setTasks((current) =>
      current.map((task) => (task.id === id ? { ...task, title: text } : task)),
    );
    setEditingId(null);
    setAnnouncement("Task updated.");
  }

  return (
    <main className="workspace">
      <header className="app-header">
        <a className="brand" href="./" aria-label="Task Manager home">
          <span className="brand-mark" aria-hidden="true">
            <Check size={23} />
          </span>{" "}
          TaskSpace<span className="demo-badge">DEMO</span>
        </a>
        <span className="header-note">A little focus. A lot of progress.</span>
      </header>
      <section className="intro" aria-labelledby="page-title">
        <p className="eyebrow">YOUR PERSONAL WORKSPACE</p>
        <h1 id="page-title">
          Make room for <span>what matters.</span>
        </h1>
        <p>Get it out of your head and into a plan. One task at a time.</p>
      </section>
      <section className="summary" aria-label="Task overview">
        <div className="stat">
          <span>Total tasks</span>
          <strong>
            {tasks.length}
            <span className="stat-icon" aria-hidden="true">
              <ListTodo />
            </span>
          </strong>
        </div>
        <div className="stat">
          <span>In progress</span>
          <strong>
            {tasks.length - completed}
            <span className="stat-icon amber" aria-hidden="true">
              <Clock3 />
            </span>
          </strong>
        </div>
        <div className="stat">
          <span>Completed tasks</span>
          <strong>
            {completed}
            <span className="stat-icon green" aria-hidden="true">
              <Check />
            </span>
          </strong>
        </div>
      </section>
      <section className="task-panel" aria-labelledby="tasks-heading">
        <div className="panel-heading">
          <div>
            <h2 id="tasks-heading">My tasks</h2>
            <p>Your next steps, all in one place.</p>
          </div>
          <span className="task-total">
            {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
          </span>
        </div>
        <form className="add-form" onSubmit={addTask}>
          <label className="sr-only" htmlFor="new-task">
            New task
          </label>
          <Plus className="add-symbol" size={23} aria-hidden="true" />
          <input
            ref={inputRef}
            id="new-task"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              setError("");
            }}
            maxLength={200}
            placeholder="What needs to get done?"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "task-error" : undefined}
          />
          <button className="primary-button" type="submit">
            <Plus size={17} aria-hidden="true" /> Add task
          </button>
        </form>
        {error && (
          <p id="task-error" className="error-message" role="alert">
            {error}
          </p>
        )}
        {storageError && (
          <p className="storage-message" role="alert">
            {storageError}
          </p>
        )}
        <div className="toolbar">
          <div className="filters" role="group" aria-label="Filter tasks">
            {filters.map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={filter === item}
                className={filter === item ? "filter selected" : "filter"}
                onClick={() => setFilter(item)}
              >
                {item}
                <span>
                  {item === "All"
                    ? tasks.length
                    : item === "Active"
                      ? tasks.length - completed
                      : completed}
                </span>
              </button>
            ))}
          </div>
          <div className="search-box">
            <Search size={18} aria-hidden="true" />
            <label className="sr-only" htmlFor="search">
              Search tasks
            </label>
            <input
              id="search"
              type="search"
              placeholder="Search tasks…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </div>
        {visibleTasks.length ? (
          <ul className="task-list">
            {visibleTasks.map((task) => (
              <li
                key={task.id}
                className={`task-row${task.completed ? " is-complete" : ""}`}
              >
                <input
                  className="task-checkbox"
                  type="checkbox"
                  checked={task.completed}
                  aria-label={`Mark ${task.title} as ${task.completed ? "active" : "completed"}`}
                  onChange={() => {
                    setTasks((current) =>
                      current.map((item) =>
                        item.id === task.id
                          ? { ...item, completed: !item.completed }
                          : item,
                      ),
                    );
                    setAnnouncement(
                      task.completed
                        ? "Task marked active."
                        : "Task completed.",
                    );
                  }}
                />
                {editingId === task.id ? (
                  <form
                    className="edit-form"
                    onSubmit={(event) => saveTask(event, task.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setEditingId(null);
                    }}
                  >
                    <label className="sr-only" htmlFor={`edit-${task.id}`}>
                      Edit task
                    </label>
                    <input
                      id={`edit-${task.id}`}
                      autoFocus
                      required
                      maxLength={200}
                      value={editTitle}
                      onChange={(event) => setEditTitle(event.target.value)}
                    />
                    <button
                      type="submit"
                      className="text-button"
                      disabled={!editTitle.trim()}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setEditingId(null)}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="task-title">{task.title}</span>
                    <span
                      className={`status-badge ${task.completed ? "done" : ""}`}
                    >
                      {task.completed ? "Completed" : "In progress"}
                    </span>
                    <div className="task-actions">
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Edit ${task.title}`}
                        title="Edit task"
                        onClick={() => {
                          setEditingId(task.id);
                          setEditTitle(task.title);
                        }}
                      >
                        <Pencil size={16} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-button delete-button"
                        aria-label={`Delete ${task.title}`}
                        title="Delete task"
                        onClick={() => {
                          setTasks((current) =>
                            current.filter((item) => item.id !== task.id),
                          );
                          setAnnouncement("Task deleted.");
                        }}
                      >
                        <Trash2 size={16} aria-hidden="true" />
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty-state">
            <div className="empty-icon" aria-hidden="true">
              {tasks.length ? <Search size={28} /> : <ClipboardList size={28} />}
            </div>
            <h3>
              {tasks.length ? "No matching tasks" : "A fresh start awaits"}
            </h3>
            <p>
              {tasks.length
                ? "Try another search or filter to find your tasks."
                : "Big ideas start with small steps. Add your first task above."}
            </p>
            {(search || filter !== "All") && (
              <button
                className="text-button"
                type="button"
                onClick={() => {
                  setSearch("");
                  setFilter("All");
                }}
              >
                Show all tasks
              </button>
            )}
          </div>
        )}
        <footer className="panel-footer">
          <span>
            {tasks.length - completed}{" "}
            {tasks.length - completed === 1 ? "task" : "tasks"} left to do
          </span>
          <button
            type="button"
            className="text-button clear-button"
            disabled={completed === 0}
            onClick={() => {
              setTasks((current) => current.filter((task) => !task.completed));
              setEditingId(null);
              setAnnouncement("Completed tasks cleared.");
            }}
          >
            Clear completed
          </button>
        </footer>
      </section>
      <section className="progress-card" aria-label="Task completion progress">
        <Sparkles className="progress-icon" size={28} aria-hidden="true" />
        <div className="progress-content">
          <div className="progress-label">
            <strong>
              {tasks.length && completed === tasks.length
                ? "All done. Take a well-earned break."
                : "Every small step counts."}
            </strong>
            <span>{progress}% complete</span>
          </div>
          <progress aria-label="Tasks completed" max="100" value={progress}>
            {progress}%
          </progress>
        </div>
      </section>
      <footer className="app-footer">
        <span>Made for a clearer mind.</span>
        <span>Tasks stay in this browser · No account needed</span>
      </footer>
      <div className="sr-only" role="status">
        {announcement}
      </div>
    </main>
  );
};

export default TaskForm;
