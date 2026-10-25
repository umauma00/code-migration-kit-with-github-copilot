<?php
enum PcMode: string {
    case PcWidget = 'w';
    case PcGadget;
    public function k($x) {
        switch ($x) {
            case PcWidget::K: return 1;
        }
    }
}
