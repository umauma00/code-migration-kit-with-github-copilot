// n is a Neg: n.WithCookie() is this file's WithCookie, not RespExt's.
namespace E { public static class NegExt {
    public static Neg WithCookie(this Neg n) => n;
    public static Neg Twice(this Neg n) { return n.WithCookie().WithCookie(); }
    public static void Other(this Neg n) { } } }
