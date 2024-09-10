import BetterSqlite3Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  defineQueue,
  defineWorker,
  JobStatus,
  ScheduledJobStatus,
} from "../src/plainjobs";
import type { Job } from "../src/plainjobs";
import { processAll } from "../src/worker";

describe("queue", async () => {
  it("should add a job to the queue", async () => {
    const connection = new BetterSqlite3Database(":memory:");
    const queue = defineQueue({ connection });
    await queue.add("paint", { color: "red" });
    const job = await queue.getAndMarkJobAsProcessing("paint");
    if (!job) throw new Error("Job not found");
    expect(JSON.parse(job.data)).toEqual({ color: "red" });
    await queue.close();
  });

  it("should add multiple jobs of the same type to the queue", async () => {
    const connection = new BetterSqlite3Database(":memory:");
    const queue = defineQueue({ connection });

    const jobData = [{ color: "red" }, { color: "green" }, { color: "blue" }];

    const { ids } = await queue.addMany("paint", jobData);

    expect(ids).toHaveLength(3);

    for (let i = 0; i < ids.length; i++) {
      const job = await queue.getJobById(ids[i]!);
      if (!job) throw new Error(`Job ${ids[i]} not found`);
      expect(job.type).toBe("paint");
      expect(JSON.parse(job.data)).toEqual(jobData[i]);
      expect(job.status).toBe(JobStatus.Pending);
    }

    expect(await queue.countJobs({ type: "paint" })).toBe(3);

    await queue.close();
  });

  it("should add a job to the queue with a custom serializer", async () => {
    const connection = new BetterSqlite3Database(":memory:");

    const customSerializer = (data: unknown) => {
      if (typeof data === "object" && data !== null) {
        return JSON.stringify(Object.entries(data).sort());
      }
      return JSON.stringify(data);
    };

    const queue = defineQueue({
      connection,
      serializer: customSerializer,
    });

    await queue.add("customSerialize", { b: 2, a: 1, c: 3 });

    const job = await queue.getAndMarkJobAsProcessing("customSerialize");
    if (!job) throw new Error("Job not found");

    expect(job.data).toBe('[["a",1],["b",2],["c",3]]');

    const parsedData = JSON.parse(job.data);
    expect(Object.fromEntries(parsedData)).toEqual({ a: 1, b: 2, c: 3 });

    await queue.close();
  });

  it("should mark jobs as done or failed", async () => {
    const connection = new BetterSqlite3Database(":memory:");
    const queue = defineQueue({ connection });
    await queue.add("test", { step: 1 });
    const job = await queue.getAndMarkJobAsProcessing("test");
    if (!job) throw new Error("job not found");
    expect(job.status).toBe(JobStatus.Processing);

    await queue.markJobAsDone(job.id);

    await queue.add("test", { step: 2 });
    const failedJob = await queue.getAndMarkJobAsProcessing("test");
    if (!failedJob) throw new Error("job not found");
    await queue.markJobAsFailed(failedJob.id, "test error");
    const found = await queue.getJobById(failedJob.id);
    expect(found?.status).toBe(JobStatus.Failed);
    expect(found?.error).toBe("test error");
  });

  it("should throw an error when adding a job with an invalid cron expression", async () => {
    const connection = new BetterSqlite3Database(":memory:");
    const queue = defineQueue({ connection });

    await expect(
      queue.schedule("invalid", { cron: "invalid cron expression" })
    ).rejects.toThrow("invalid cron expression provided");
  });

  it("should get and mark scheduled job as processing", async () => {
    const connection = new BetterSqlite3Database(":memory:");
    const queue = defineQueue({ connection });

    await queue.schedule("scheduled", { cron: "* * * * *" });

    const job = await queue.getAndMarkScheduledJobAsProcessing();
    if (!job) throw new Error("Job not found");
    expect(job).toBeDefined();
    expect(job?.status).toBe(JobStatus.Processing);

    const updatedJob = await queue.getScheduledJobById(job.id);
    expect(updatedJob?.status).toBe(JobStatus.Processing);

    await queue.close();
  });

  it("should mark scheduled job as idle with next run time", async () => {
    const connection = new BetterSqlite3Database(":memory:");
    const queue = defineQueue({ connection });

    const { id } = await queue.schedule("scheduled", { cron: "* * * * * *" });

    const job = await queue.getAndMarkScheduledJobAsProcessing();
    expect(job).toBeDefined();

    const nextRun = Date.now() + 60000; // 1 minute from now
    await queue.markScheduledJobAsIdle(id, nextRun);

    const updatedJob = await queue.getScheduledJobById(id);
    expect(updatedJob?.status).toBe(ScheduledJobStatus.Idle);
    expect(updatedJob?.nextRun).toBe(nextRun);

    await queue.close();
  });

  it("should requeue timed out jobs", async () => {
    const connection = new BetterSqlite3Database(":memory:");
    const queue = defineQueue({
      connection,
      timeout: 25,
      maintenanceInterval: 20,
    });

    const { id } = await queue.add("test", { value: "timeout test" });

    const job = await queue.getAndMarkJobAsProcessing("test");
    expect(job).toBeDefined();
    expect(job?.id).toBe(id);
    expect(job?.status).toBe(JobStatus.Processing);

    await new Promise((resolve) => setTimeout(resolve, 80));

    const requeuedJob = await queue.getJobById(id);
    expect(requeuedJob?.status).toBe(JobStatus.Pending);

    await queue.close();
  });

  it("should remove done jobs older than specified time", async () => {
    const connection = new BetterSqlite3Database(":memory:");
    const queue = defineQueue({
      connection,
      removeDoneJobsOlderThan: 20,
    });

    const { id: oldJobId } = await queue.add("test", { value: "old job" });
    const oldJob = await queue.getAndMarkJobAsProcessing("test");
    if (oldJob) await queue.markJobAsDone(oldJob.id);

    await new Promise((resolve) => setTimeout(resolve, 50));

    const { id: newJobId } = await queue.add("test", { value: "new job" });
    const newJob = await queue.getAndMarkJobAsProcessing("test");
    if (newJob) await queue.markJobAsDone(newJob.id);

    await queue.removeDoneJobs(20);

    expect(await queue.getJobById(oldJobId)).toBeUndefined();
    expect(await queue.getJobById(newJobId)).toBeDefined();

    await queue.close();
  });

  it("should remove failed jobs older than specified time", async () => {
    const connection = new BetterSqlite3Database(":memory:");
    const queue = defineQueue({
      connection,
      removeFailedJobsOlderThan: 20,
    });

    const { id: oldJobId } = await queue.add("test", { value: "old job" });
    const oldJob = await queue.getAndMarkJobAsProcessing("test");
    if (oldJob) await queue.markJobAsFailed(oldJob.id, "Test error");

    await new Promise((resolve) => setTimeout(resolve, 50));

    const { id: newJobId } = await queue.add("test", { value: "new job" });
    const newJob = await queue.getAndMarkJobAsProcessing("test");
    if (newJob) await queue.markJobAsFailed(newJob.id, "Test error");

    await queue.removeFailedJobs(20);

    expect(await queue.getJobById(oldJobId)).toBeUndefined();
    expect(await queue.getJobById(newJobId)).toBeDefined();

    await queue.close();
  });

  it("should count jobs by type and status", async () => {
    const connection = new BetterSqlite3Database(":memory:");
    const queue = defineQueue({ connection });

    await queue.add("test1", { value: 1 });
    await queue.add("test1", { value: 2 });
    await queue.add("test2", { value: 3 });
    await queue.add("test3", { value: 3 });

    expect(
      await queue.countJobs({ type: "test1", status: JobStatus.Pending })
    ).toBe(2);
    expect(
      await queue.countJobs({ type: "test2", status: JobStatus.Pending })
    ).toBe(1);
    expect(
      await queue.countJobs({ type: "test1", status: JobStatus.Processing })
    ).toBe(0);
    expect(await queue.countJobs({ type: "test3" })).toBe(1);
    expect(await queue.countJobs({ status: JobStatus.Pending })).toBe(4);
    expect(await queue.countJobs()).toBe(4);

    const job = await queue.getAndMarkJobAsProcessing("test1");

    expect(
      await queue.countJobs({ type: "test1", status: JobStatus.Processing })
    ).toBe(1);
    expect(
      await queue.countJobs({ type: "test1", status: JobStatus.Pending })
    ).toBe(1);
    expect(await queue.countJobs({ status: JobStatus.Pending })).toBe(3);

    if (job) await queue.markJobAsDone(job.id);
    expect(
      await queue.countJobs({ type: "test1", status: JobStatus.Done })
    ).toBe(1);
    expect(await queue.countJobs({ status: JobStatus.Done })).toBe(1);
    expect(await queue.countJobs({ type: "test5" })).toBe(0);
    expect(await queue.countJobs()).toBe(4);

    await queue.close();
  });

  it("should return all scheduled jobs", async () => {
    const connection = new BetterSqlite3Database(":memory:");
    const queue = defineQueue({ connection });

    await queue.schedule("job1", { cron: "* * * * *" });
    await queue.schedule("job2", { cron: "0 0 * * *" });
    await queue.schedule("job3", { cron: "0 12 * * MON-FRI" });

    const scheduledJobs = await queue.getScheduledJobs();

    expect(scheduledJobs).toHaveLength(3);
    expect(scheduledJobs[0]?.type).toBe("job1");
    expect(scheduledJobs[1]?.type).toBe("job2");
    expect(scheduledJobs[2]?.type).toBe("job3");
    expect(scheduledJobs[0]?.cronExpression).toBe("* * * * *");
    expect(scheduledJobs[1]?.cronExpression).toBe("0 0 * * *");
    expect(scheduledJobs[2]?.cronExpression).toBe("0 12 * * MON-FRI");

    await queue.close();
  });

  it("should return an empty array when no scheduled jobs exist", async () => {
    const connection = new BetterSqlite3Database(":memory:");
    const queue = defineQueue({ connection });

    const scheduledJobs = await queue.getScheduledJobs();

    expect(scheduledJobs).toHaveLength(0);
    expect(scheduledJobs).toEqual([]);

    await queue.close();
  });

  it("should return all unique job types", async () => {
    const connection = new BetterSqlite3Database(":memory:");
    const queue = defineQueue({ connection });

    await queue.add("type1", { data: "job1" });
    await queue.add("type2", { data: "job2" });
    await queue.add("type1", { data: "job3" });
    await queue.add("type3", { data: "job4" });

    const jobTypes = await queue.getJobTypes();

    expect(jobTypes).toHaveLength(3);
    expect(jobTypes).toContain("type1");
    expect(jobTypes).toContain("type2");
    expect(jobTypes).toContain("type3");

    await queue.close();
  });

  it("should return an empty array when no jobs exist", async () => {
    const connection = new BetterSqlite3Database(":memory:");
    const queue = defineQueue({ connection });

    const jobTypes = await queue.getJobTypes();

    expect(jobTypes).toHaveLength(0);
    expect(jobTypes).toEqual([]);

    await queue.close();
  });

  it("should call onDoneJobsRemoved when done jobs are removed", async () => {
    let removedJobs = 0;
    const connection = new BetterSqlite3Database(":memory:");
    const queue = defineQueue({
      connection,
      removeDoneJobsOlderThan: 10,
      onDoneJobsRemoved: (n) => {
        removedJobs = n;
      },
    });

    await queue.add("test", { value: "old job" });
    const job = await queue.getAndMarkJobAsProcessing("test");
    if (job) await queue.markJobAsDone(job.id);

    await new Promise((resolve) => setTimeout(resolve, 20));

    await queue.removeDoneJobs(10);

    expect(removedJobs).toBe(1);

    await queue.close();
  });

  it("should call onFailedJobsRemoved when failed jobs are removed", async () => {
    let removedJobs = 0;
    const connection = new BetterSqlite3Database(":memory:");
    const queue = defineQueue({
      connection,
      removeFailedJobsOlderThan: 10,
      onFailedJobsRemoved: (n) => {
        removedJobs = n;
      },
    });

    await queue.add("test", { value: "old job" });
    const job = await queue.getAndMarkJobAsProcessing("test");
    if (job) await queue.markJobAsFailed(job.id, "Test error");

    await new Promise((resolve) => setTimeout(resolve, 20));

    await queue.removeFailedJobs(10);

    expect(removedJobs).toBe(1);

    await queue.close();
  });

  it("should call onProcessingJobsRequeued when processing jobs are requeued", async () => {
    let requeuedJobs = 0;
    const connection = new BetterSqlite3Database(":memory:");
    const queue = defineQueue({
      connection,
      timeout: 10,
      onProcessingJobsRequeued: (n) => {
        requeuedJobs = n;
      },
    });

    await queue.add("test", { value: "timeout test" });
    await queue.getAndMarkJobAsProcessing("test");

    await new Promise((resolve) => setTimeout(resolve, 20));

    await queue.requeueTimedOutJobs(10);

    expect(requeuedJobs).toBe(1);

    await queue.close();
  });

  it("should update an existing scheduled job when adding the same type with a different cron expression", async () => {
    const connection = new BetterSqlite3Database(":memory:");
    const queue = defineQueue({ connection });

    const { id: initialId } = await queue.schedule("updateTest", {
      cron: "0 * * * *",
    });

    const initialJob = await queue.getScheduledJobById(initialId);
    expect(initialJob).toBeDefined();
    expect(initialJob?.cronExpression).toBe("0 * * * *");

    const { id: updatedId } = await queue.schedule("updateTest", {
      cron: "*/30 * * * *",
    });

    expect(updatedId).toBe(initialId);

    const updatedJob = await queue.getScheduledJobById(updatedId);
    expect(updatedJob).toBeDefined();
    expect(updatedJob?.cronExpression).toBe("*/30 * * * *");

    const allJobs = await queue.getScheduledJobs();
    const updateTestJobs = allJobs.filter((job) => job.type === "updateTest");
    expect(updateTestJobs).toHaveLength(1);

    await queue.close();
  });
});

describe("worker", async () => {
  it("should process jobs with a worker", async () => {
    const connection = new BetterSqlite3Database(":memory:");
    const queue = defineQueue({ connection });
    const results: unknown[] = [];
    const worker = defineWorker(
      "test",
      async (job: Job) => {
        results.push(JSON.parse(job.data));
      },
      { queue }
    );

    await queue.add("test", { value: 1 });
    await queue.add("test", { value: 2 });

    await processAll(queue, worker);

    expect(results).toEqual([{ value: 1 }, { value: 2 }]);
  });

  it("should process scheduled jobs", async () => {
    const connection = new BetterSqlite3Database(":memory:");
    const queue = defineQueue({ connection });
    const results: unknown[] = [];
    const worker = defineWorker(
      "scheduled",
      async (job: Job) => {
        results.push(JSON.parse(job.data));
      },
      { queue }
    );

    await queue.schedule("scheduled", { cron: "* * * * *" });

    worker.start();
    await processAll(queue, worker);

    expect(results[0]).toEqual({});
  });

  it("should add a job with id and retrieve it", async () => {
    const connection = new BetterSqlite3Database(":memory:");
    const queue = defineQueue({ connection });

    const { id } = await queue.add("paint", { color: "blue" });
    expect(id).toBeDefined();

    const job = await queue.getJobById(id);
    expect(job).toBeDefined();
    expect(job?.type).toBe("paint");
    expect(JSON.parse(job?.data as string)).toEqual({ color: "blue" });

    const worker = defineWorker("paint", async (job: Job) => {}, { queue });

    await processAll(queue, worker);

    const processedJob = await queue.getJobById(id);
    expect(processedJob?.status).toBe(JobStatus.Done);
    expect(processedJob?.type).toBe("paint");
  });

  it("should reprocess a job that has been stuck in processing for too long", async () => {
    const connection = new BetterSqlite3Database(":memory:");
    const queue = defineQueue({
      connection,
      timeout: 10,
      maintenanceInterval: 40,
    });

    const { id } = await queue.add("test", { value: "timeout test" });

    // simulate worker dying
    const job = await queue.getAndMarkJobAsProcessing("test");
    expect(job).toBeDefined();
    expect(job?.id).toBe(id);
    expect(job?.status).toBe(JobStatus.Processing);

    await new Promise((resolve) => setTimeout(resolve, 70));

    const results: unknown[] = [];
    const worker = defineWorker(
      "test",
      async (job: Job) => {
        results.push(JSON.parse(job.data));
      },
      { queue }
    );

    await processAll(queue, worker);

    expect(results).toEqual([{ value: "timeout test" }]);
  });

  it("should store error information when a job fails", async () => {
    const connection = new BetterSqlite3Database(":memory:");
    const queue = defineQueue({ connection });

    const { id } = await queue.add("test", { value: "error test" });

    const worker = defineWorker(
      "test",
      async (job: Job) => {
        throw new Error("test error");
      },
      { queue }
    );

    await processAll(queue, worker);

    const failedJob = await queue.getJobById(id);
    expect(failedJob).toBeDefined();
    expect(failedJob?.status).toBe(JobStatus.Failed);
    expect(failedJob?.failedAt).toBeDefined();
    expect(failedJob?.failedAt).not.toBeNull();
    expect(failedJob?.error).toContain("test error");
  });

  it("should store error information when a scheduled job fails", async () => {
    const connection = new BetterSqlite3Database(":memory:");
    const queue = defineQueue({ connection });

    const { id } = await queue.schedule("paint", { cron: "* * * * * *" });

    const worker = defineWorker(
      "paint",
      async (job: Job) => {
        throw new Error("test error");
      },
      { queue }
    );

    worker.start();
    await processAll(queue, worker);

    const failedJob = await queue.getJobById(id);
    expect(failedJob).toBeDefined();
    expect(failedJob?.status).toBe(JobStatus.Failed);
    expect(failedJob?.failedAt).toBeDefined();
    expect(failedJob?.error).toContain("test error");
    expect(failedJob?.failedAt).not.toBeNull();
  });

  it("should call onProcessing when a job starts processing", async () => {
    const connection = new BetterSqlite3Database(":memory:");
    const queue = defineQueue({ connection });
    let processingCalled = false;

    const worker = defineWorker("test", async (job: Job) => {}, {
      queue,
      onProcessing: (job: Job) => {
        processingCalled = true;
      },
    });

    await queue.add("test", { value: "processing test" });
    await processAll(queue, worker);

    expect(processingCalled).toBe(true);
  });

  it("should call onCompleted when a job is completed", async () => {
    const connection = new BetterSqlite3Database(":memory:");
    const queue = defineQueue({ connection });
    let completedJob!: Job;

    const worker = defineWorker("test", async (job: Job) => {}, {
      queue,
      onCompleted: (job: Job) => {
        completedJob = job;
      },
    });

    await queue.add("test", { value: "completed test" });
    await processAll(queue, worker);

    expect(JSON.parse(completedJob.data)).toEqual({ value: "completed test" });
  });

  it("should call onFailed when a job fails", async () => {
    const connection = new BetterSqlite3Database(":memory:");
    const queue = defineQueue({ connection });
    let failedJob!: Job;
    let failedError!: string;

    const worker = defineWorker(
      "test",
      async (job: Job) => {
        throw new Error("Test error");
      },
      {
        queue,
        onFailed: (job: Job, error: string) => {
          failedJob = job;
          failedError = error;
        },
      }
    );

    await queue.add("test", { value: "failed test" });
    await processAll(queue, worker);

    expect(JSON.parse(failedJob.data)).toEqual({ value: "failed test" });
    expect(failedError).toContain("Test error");
  });
});
