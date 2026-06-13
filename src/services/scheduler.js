import cron from 'node-cron';

class SchedulerService {
  constructor() { this.tasks = new Map(); }

  add(name, cronExpr, callback) {
    if (!cron.validate(cronExpr)) throw new Error(`Invalid cron: ${cronExpr}`);
    const task = cron.schedule(cronExpr, callback);
    this.tasks.set(name, task);
    return task;
  }

  stop(name) { const t = this.tasks.get(name); if (t) { t.stop(); this.tasks.delete(name); } }
  stopAll() { for (const [,t] of this.tasks) t.stop(); this.tasks.clear(); }
}

export default SchedulerService;
