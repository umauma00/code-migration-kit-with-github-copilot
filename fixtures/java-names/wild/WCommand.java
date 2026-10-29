package wild;
// A field of a wildcard type (WJob<?, ?>) is still typed: job.report()
// reaches WReport.
public class WCommand {
    protected WJob<?, ?> job;
    void run(java.util.List<? extends WJob<?, ?>> jobs) { job.report(); }
}
