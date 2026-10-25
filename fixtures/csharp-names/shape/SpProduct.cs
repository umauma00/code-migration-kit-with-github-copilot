namespace Shp {
  // A property named like a type, used as a value after a comma or in an
  // interpolation hole: not the type (no false SpCategory/SpProduct cycle).
  public class SpProduct {
    public string SpCategory { get; set; } = "";
    public string Name { get; set; } = "";
    public override string ToString() => $"{SpCategory}: {Name}";
    public string Format() => string.Format("{0}: {1}", Name, SpCategory);
    public void Log() { Write(Name, SpCategory); }
    void Write(string a, string b) { }
  }
}
