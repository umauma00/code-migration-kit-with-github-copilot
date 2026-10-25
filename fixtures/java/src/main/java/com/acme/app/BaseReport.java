package com.acme.app;

import com.acme.model.Shipment;

abstract class BaseReport {
    protected Shipment shipment() { return new Shipment(); }
}
