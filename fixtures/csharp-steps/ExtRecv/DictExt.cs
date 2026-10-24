// Add on a framework type: l.Add(1) in U.cs is List<int>.Add, so no edge
// from U.cs (and no false cycle through the field below).
namespace E { public static class DictExt { static U u; public static void Add(this System.Collections.Generic.IDictionary<string, int> d, string k) { } } }
