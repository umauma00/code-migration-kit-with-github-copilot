global using Shop.Core;
using Shop.Data.Repos;
using Alias = Shop.Util.Formatter;
using static Shop.Util.MathHelpers;

namespace Shop.App;

[Audited]
public class Program
{
    // OrderService in a comment is not a reference.
    public static void Main(string[] args)
    {
        var repo = new OrderRepository();
        var text = $"total: {Alias.Format(Twice(2))}";
        var note = @"new Ignored() ""quoted"" { brace";
        var legacy = Type.GetType("Shop.Data.Legacy");
        var other = Type.GetType(args[0]);
        System.Console.WriteLine("x".Shout());
    }
}
