Public Class ShMessage
    Public Property Owner As ShLogger
    Public Shared Function Create() As ShMessage
        Return New ShMessage()
    End Function
End Class
