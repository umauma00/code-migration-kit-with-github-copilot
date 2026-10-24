// string.Join is a static call, not this Join.
namespace E { public class Bag { } public static class BagExt { static S s; public static string Join(this Bag b) => ""; } }
