       IDENTIFICATION DIVISION.
       PROGRAM-ID. MAIN.
       PROCEDURE DIVISION.
           IF X = 1
               CALL
                       'SUBA'
                   USING X
           END-IF.
           DISPLAY 'CALL SUBB'.
           STOP RUN.
