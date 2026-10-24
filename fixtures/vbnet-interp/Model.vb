Public Class Config
End Class

Public Class Model
    Public Property Name As String
    Public Settings As Config
    Public Getter As Config
End Class

' Still read after the auto-implemented property above.
Public Class Second
End Class
