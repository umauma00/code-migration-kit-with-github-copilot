package com.acme.app;

import com.acme.model.Order;

// Customer, Address, Shipment and Order.Line are never written here: their
// files are reached through declared return and member types.
public class Report extends BaseReport {
    void run(Order order) {
        var customer = order.getCustomer();
        customer.getAddress().format();
        for (var line : order.getLines()) {
            System.out.println(line.qty());
        }
        super.shipment().send();
    }
}
