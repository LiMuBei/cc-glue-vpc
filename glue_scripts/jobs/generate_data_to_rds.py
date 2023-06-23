import pandas as pd
import numpy as np


def generate_random_sales_row():
    # Let's generate a random sales row
    row = {
        "product_id": np.random.randint(0, 100),
        "sales": np.random.randint(0, 100),
        "date": pd.Timestamp("2023-01-01")
        + pd.Timedelta(days=np.random.randint(0, 300)),
    }
    return row


def generate_data():
    print("Generating data...")
    df = pd.DataFrame(
        [generate_random_sales_row() for _ in range(1000)],
        columns=["product_id", "sales", "date"],
    )
    return df


if __name__ == "__main__":
    data = generate_data()
