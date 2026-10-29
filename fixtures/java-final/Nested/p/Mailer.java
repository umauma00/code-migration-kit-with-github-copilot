package p;
// Nested DescriptorImpl in several classes of one package: each is its own type.
public class Mailer { public static DescriptorImpl descriptor() { return null; } public static class DescriptorImpl { } }
