// Compatibility only: old saved/imported schedules must not call retired handlers.
const retired = new Set(['batchbaoku13', 'batchbaoku45', 'batchSmartSendCar', 'batchClaimCars']);
export function removeRetiredTasks(task) {
  if (!task || !Array.isArray(task.selectedTasks)) return task;
  const selectedTasks = task.selectedTasks.filter(name => !retired.has(name));
  if (selectedTasks.length === task.selectedTasks.length) return task;
  return { ...task, selectedTasks, ...(selectedTasks.length ? {} : { enabled: false }) };
}
