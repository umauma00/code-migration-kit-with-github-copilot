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
