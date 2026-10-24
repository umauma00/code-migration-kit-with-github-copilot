// Cache resolves, so it is not also read as CacheAttribute: that would be
// a false cycle with CacheAttribute.cs, which uses Cache.
namespace N2 { public class Cache { public static int Get() { return 1; } } }
