namespace N;

// global:: starts from the root namespace: X.Target, never N.X.Target.
class Rooted
{
    global::X.Target field;

    void Run()
    {
        var t = new global::X.Target();
    }
}
