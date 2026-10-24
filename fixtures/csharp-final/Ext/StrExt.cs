// C# 14 extension block: IsBlank is called as s.IsBlank().
public static class StrExt
{
    extension(string s)
    {
        public bool IsBlank() => s.Length == 0;
    }
}
