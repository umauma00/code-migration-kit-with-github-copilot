// Names inside interpolation holes are code, whatever the hole holds.
class Use
{
    string A() => $"x {(true ? 0 : L.Alpha.N)}";
    string B() => $"{global::L.Beta.N}";
    string C() => $"""
        raw {L.Gamma.N}
        """;
    string D() => $"{L.Delta.N:D3}";
    string E() => $$"""
        {not a hole} {{L.Eps.N}}
        """;
    string F() => $"{(c == '}' ? M.Other.N : 0)}";
    char c;
}

// @"""x"" y" is a verbatim string that starts with an escaped quote, not a
// raw string: the code after it is still read. A literal inside a hole is a
// string, not a type name.
class Verbatim
{
    string q = @"""Hello"" world";
    int z = Zed.N;
    string Count(int n) => $"{n} {(n == 1 ? "Item" : "Items")}";
}
